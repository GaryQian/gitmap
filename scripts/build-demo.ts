// Build a demo (PLAN.md §12.1): two static files per repo, served from the app's own origin.
//
//   <out>/<name>/snapshot.starmap.json.gz   the parsed model, loaded when the demo pill is clicked
//   <out>/<name>/content.zip               the text of every file on the map at the parsed commit,
//                                          read one entry at a time by src/content's demoSource
//
// Usage: node scripts/run.mjs scripts/build-demo.ts <local clone> [--name demo-small] [--out public/demo]
//          [--source-url URL] [--allow-unknown-license]
//
// The steps run in the order of `main` below. Two of them are hooks that other packages fill in:
// `computeHistoryLayers` (history overlays) and `generateAnnotations` (AI pre-generation).
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zipSync, type Zippable } from 'fflate';
import { config, type Config, type DemoRepo } from '../src/config';
import { extractZipEntry, findZipEnd, parseZipDirectory, ZIP_END_MAX } from '../src/content';
import { MODE_TREE, openGitRepo, parseCommit, treeEntries, type GitRepository } from '../src/git';
import { openNodeRepoAccess } from '../src/git/node';
import { encodeModel, type RepoModel } from '../src/model';
import { runHeadless } from '../src/pipeline/node';
import { basename, dirname, extname, gitBlobOid } from '../src/shared';

// ---- command line ----

interface Args {
  rootPath: string;
  name: string;
  out: string;
  sourceUrl: string | null;
  allowUnknownLicense: boolean;
}

const USAGE = 'usage: node scripts/run.mjs scripts/build-demo.ts <local clone> [--name demo-small] [--out public/demo] [--source-url URL] [--allow-unknown-license]';
const VALUE_FLAGS = new Set(['--name', '--out', '--source-url']);
const BOOLEAN_FLAGS = new Set(['--allow-unknown-license']);

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value\n${USAGE}`);
      values.set(arg, value);
    } else if (BOOLEAN_FLAGS.has(arg)) flags.add(arg);
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}\n${USAGE}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new Error(USAGE);
  const rootPath = path.resolve(positional[0]);
  const name = values.get('--name') ?? path.basename(rootPath);
  // the name becomes a folder and part of a URL
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`--name must be letters, digits, '.', '_' or '-': got "${name}"`);
  return {
    rootPath, name,
    out: path.resolve(values.get('--out') ?? 'public/demo'),
    sourceUrl: values.get('--source-url') ?? null,
    allowUnknownLicense: flags.has('--allow-unknown-license'),
  };
}

// ---- licence ----

export interface DetectedLicense {
  /** SPDX id when recognised; otherwise the file's first non-empty line ('' for an empty file). */
  license: string;
  recognised: boolean;
}

/** Licence files travel with the code whatever else is left out (PLAN.md §12.1). */
const NOTICE_FILE = /^(LICEN[CS]E|NOTICE|COPYING|UNLICEN[CS]E)([.-].*)?$/i;

/** Match a licence text against the common permissive licences, by its title and then by its wording. */
export function detectLicense(text: string): DetectedLicense {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const title = lines.slice(0, 3).join(' ').replace(/\s+/g, ' ');
  const whole = lines.join(' ').replace(/\s+/g, ' ');
  const found = (license: string): DetectedLicense => ({ license, recognised: true });
  if (/\bMIT License\b/i.test(title)) return found('MIT');
  if (/\bApache License\b/i.test(title) && /\bVersion 2\.0\b/i.test(title)) return found('Apache-2.0');
  if (/\bMozilla Public License,? Version 2\.0\b/i.test(title)) return found('MPL-2.0');
  if (/\bISC License\b/i.test(title)) return found('ISC');
  if (/\bBSD 3-Clause\b/i.test(title)) return found('BSD-3-Clause');
  if (/\bBSD 2-Clause\b/i.test(title)) return found('BSD-2-Clause');
  // Many licence files start with the copyright line instead of a title: go by the operative sentence.
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy of this software/i.test(whole)
    && /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/i.test(whole)) return found('MIT');
  if (/Permission to use, copy, modify, and(\/or)? distribute this software for any purpose with or without fee is hereby granted/i.test(whole)) return found('ISC');
  if (/Redistribution and use in source and binary forms, with or without modification, are permitted/i.test(whole)) {
    if (/must display the following acknowledge?ment/i.test(whole)) return { license: lines[0] ?? '', recognised: false }; // 4-clause
    return found(/Neither the name of .{1,200} nor the names of|may not be used to endorse or promote products/i.test(whole) ? 'BSD-3-Clause' : 'BSD-2-Clause');
  }
  return { license: lines[0] ?? '', recognised: false };
}

// ---- git ----

/** Every blob of a commit's tree: path → oid. Submodules are skipped. */
function treeBlobs(repo: GitRepository, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  const tree = repo.readObject(treeOid);
  if (!tree || tree.type !== 'tree') throw new Error(`git: tree ${treeOid} is missing from the clone (a shallow or partial clone?)`);
  for (const entry of treeEntries(tree.data)) {
    if (entry.mode === MODE_TREE) treeBlobs(repo, entry.oid, `${prefix}${entry.name}/`, out);
    else out.set(prefix + entry.name, entry.oid);
  }
  return out;
}

function readBlob(repo: GitRepository, oid: string): Uint8Array | null {
  const object = repo.readObject(oid);
  return object && object.type === 'blob' ? object.data : null;
}

/** The repo's main licence file at the root, by preference. */
function findLicenseFile(committed: Map<string, string>): string | null {
  const roots = [...committed.keys()].filter((p) => !p.includes('/') && /^(LICEN[CS]E|COPYING)([.-].*)?$/i.test(p));
  const rank = (p: string): number => (/^LICEN[CS]E$/i.test(p) ? 0 : /^LICEN[CS]E\.(md|txt)$/i.test(p) ? 1 : /^LICEN[CS]E/i.test(p) ? 2 : 3);
  roots.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  return roots[0] ?? null;
}

// ---- the steps ----

interface BuildContext {
  args: Args;
  config: Config;
  repo: GitRepository;
  headOid: string;
  /** Committer time of the parsed commit, ms. */
  commitTime: number;
  /** path → blob oid at the parsed commit. */
  committed: Map<string, string>;
  /** The model being built. Steps change it in place. */
  model: RepoModel;
}

/** Step 1: the same parse, cluster and layout pipeline as the app, headless. */
async function runPipeline(args: Args): Promise<RepoModel> {
  const t0 = performance.now();
  let lastStage = '';
  const result = await runHeadless({ kind: 'directory', locator: { kind: 'node', rootPath: args.rootPath } }, config, {
    onEvent(evt, payload) {
      if (evt !== 'stage') return;
      const s = payload as { stage: string; label: string };
      if (s.stage !== lastStage) { lastStage = s.stage; console.log(`[${((performance.now() - t0) / 1000).toFixed(2)}s] ${s.stage} ${s.label}`); }
    },
  });
  const { model } = result;
  result.dispose();
  return model;
}

/**
 * HOOK — history overlays (PLAN.md §12.1 "Building a demo", step 3; the M4 history packages).
 * Walk history once to compute the overlay layers (Recency, Ownership, Knowledge risk) and the
 * contributor table, write them into `ctx.model.layers` / `ctx.model.tables.contributor`, then
 * discard the history: no commits, trees or diffs go into the snapshot.
 * Currently a no-op: the snapshot has no history layers.
 */
async function computeHistoryLayers(_ctx: BuildContext): Promise<void> {
  // filled in by the history package
}

/**
 * HOOK — AI pre-generation (PLAN.md §12.1 "Building a demo", step 4; package 5F).
 * Generate summaries, points of interest, the tour and each point of interest's detail cards with
 * the developer's key and write them into `ctx.model.annotations` (and `meta.digestHash`), so the
 * demo makes no model calls.
 * Currently a no-op: the snapshot has no annotations.
 */
async function generateAnnotations(_ctx: BuildContext): Promise<void> {
  // filled in by package 5F
}

/** Step 2: what a demo snapshot may and must say about itself. */
function finishModel(ctx: BuildContext, license: string): void {
  const { model, args } = ctx;
  // names stay so the Ownership picker works; addresses do not ship
  const contributors = model.tables.contributor;
  contributors.cols.emails = contributors.ids.map(() => '');
  const sourceUrl = args.sourceUrl ?? (model.meta.remoteUrl && !model.meta.remoteUrl.startsWith('/') ? `https://${model.meta.remoteUrl}` : '');
  model.meta = {
    ...model.meta,
    // its own id, so a demo never shares a registry or snapshot slot with the user's clone of the same repo
    id: `demo:${args.name}`,
    source: 'demo',
    headOid: ctx.headOid,
    // there is no working tree to compare against
    indexChecksum: null,
    demo: { sourceUrl, commit: ctx.headOid, license },
  };
}

interface Pack {
  zip: Uint8Array;
  entries: number;
  rawBytes: number;
  skipped: { binary: number; tooLarge: number; missing: number };
}

const looksBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, 8000).includes(0);

/** Step 4: every file that has a sphere and is text, from the committed blobs, plus the licence files. */
function buildPack(ctx: BuildContext): Pack {
  const { model, repo } = ctx;
  const binary = new Set(ctx.config.parser.binaryExtensions);
  const maxBytes = ctx.config.parser.maxFileBytes;
  const files = model.tables.file;
  const input: Zippable = {};
  const pack: Pack = { zip: new Uint8Array(0), entries: 0, rawBytes: 0, skipped: { binary: 0, tooLarge: 0, missing: 0 } };
  // a fixed time, so the same commit always produces the same archive
  const mtime = new Date(Math.min(Math.max(ctx.commitTime, Date.UTC(1980, 0, 2)), Date.UTC(2099, 0, 1)));
  const add = (file: string, bytes: Uint8Array): void => {
    input[file] = [bytes, { level: 9, mtime }];
    pack.entries++;
    pack.rawBytes += bytes.length;
  };
  const dirs = new Set<string>(['']);
  for (let row = 0; row < files.ids.length; row++) {
    const file = files.ids[row];
    const oid = files.cols.oid![row];
    if (binary.has(extname(file))) { pack.skipped.binary++; continue; }
    const bytes = oid ? readBlob(repo, oid) : null;
    if (!bytes) { pack.skipped.missing++; continue; }
    if (bytes.length > maxBytes) { pack.skipped.tooLarge++; continue; }
    if (looksBinary(bytes)) { pack.skipped.binary++; continue; }
    add(file, bytes);
    for (let dir = dirname(file); !dirs.has(dir); dir = dirname(dir)) dirs.add(dir);
  }
  // Licence and notice files of the root and of every folder that has packed code, on the map or not.
  for (const [file, oid] of ctx.committed) {
    if (input[file] || !NOTICE_FILE.test(basename(file)) || !dirs.has(dirname(file))) continue;
    const bytes = readBlob(repo, oid);
    if (bytes) add(file, bytes);
  }
  // demoSource reads archives without zip64 only
  if (pack.entries > 65534) throw new Error(`${pack.entries} files are too many for the content pack (the limit without zip64 is 65,534).`);
  pack.zip = zipSync(input);
  if (pack.zip.length >= 0xffffffff) throw new Error('The content pack would pass 4 GB, which needs zip64.');
  return pack;
}

/** Read every entry back with the app's own zip reader and check it against the snapshot's blob oids. */
async function verifyPack(ctx: BuildContext, zip: Uint8Array): Promise<void> {
  const end = findZipEnd(zip.subarray(Math.max(0, zip.length - ZIP_END_MAX)));
  const entries = parseZipDirectory(zip.subarray(end.cdOffset, end.cdOffset + end.cdSize), end);
  const files = ctx.model.tables.file;
  const oidOf = new Map(files.ids.map((id, row) => [id, files.cols.oid![row]]));
  for (const entry of entries) {
    const bytes = await extractZipEntry(zip.subarray(entry.offset, entry.end), entry);
    const expected = oidOf.get(entry.path) ?? ctx.committed.get(entry.path);
    if ((await gitBlobOid(bytes)) !== expected) throw new Error(`content pack check failed: ${entry.path} does not hash to ${expected}`);
  }
}

const kb = (bytes: number): string => `${(bytes / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} KB`;

export default async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  // ---- the clone and its commit ----
  const access = await openNodeRepoAccess(args.rootPath);
  if (!access.git) throw new Error(`${args.rootPath} is not a git clone: a demo is built from one commit.`);
  const repo = openGitRepo(access.git);
  const headOid = repo.head().oid;
  const head = headOid ? repo.readObject(headOid) : null;
  if (!headOid || !head || head.type !== 'commit') throw new Error(`${args.rootPath} has no commit checked out.`);
  const commit = parseCommit(head.data);
  const committed = treeBlobs(repo, commit.tree);

  // ---- the licence, before any work: permissive licences require the notice to travel with the code ----
  const licenseFile = findLicenseFile(committed);
  const licenseText = licenseFile ? readBlob(repo, committed.get(licenseFile)!) : null;
  const detected: DetectedLicense = licenseText ? detectLicense(new TextDecoder().decode(licenseText)) : { license: '', recognised: false };
  if (!detected.recognised && !args.allowUnknownLicense) {
    const seen = licenseFile ? `${licenseFile} starts with "${detected.license}", which is not one of MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC or MPL-2.0` : 'the repo has no LICENSE or COPYING file at its root';
    throw new Error(`Licence not recognised: ${seen}.\nA demo republishes the repo's files, so check that its licence allows that, then pass --allow-unknown-license.`);
  }
  const license = detected.license || 'unknown';
  console.log(`licence: ${license}${detected.recognised ? '' : ' (not recognised)'}${licenseFile ? `, from ${licenseFile}` : ''}`);

  // ---- 1. parse, cluster, lay out ----
  const model = await runPipeline(args);
  const ctx: BuildContext = { args, config, repo, headOid, commitTime: commit.committer.time * 1000, committed, model };

  // The map is parsed from the index; the demo names one commit. They must be the same files.
  const files = model.tables.file;
  const staged = files.ids.filter((id, row) => files.cols.oid![row] !== (committed.get(id) ?? ''));
  if (staged.length) {
    throw new Error(`${staged.length} file(s) on the map differ from commit ${headOid.slice(0, 10)} (${staged.slice(0, 5).join(', ')}${staged.length > 5 ? ', …' : ''}).\nCommit or unstage them: a demo is built from one commit.`);
  }

  // ---- hooks other packages fill in ----
  await computeHistoryLayers(ctx);
  await generateAnnotations(ctx);

  // ---- 2. strip e-mail addresses; record source, commit and licence ----
  finishModel(ctx, license);

  // ---- 3. the snapshot ----
  const dir = path.join(args.out, args.name);
  mkdirSync(dir, { recursive: true });
  const snapshotPath = path.join(dir, 'snapshot.starmap.json.gz');
  writeFileSync(snapshotPath, await encodeModel(model));

  // ---- 4. the content pack ----
  const pack = buildPack(ctx);
  await verifyPack(ctx, pack.zip);
  const zipPath = path.join(dir, 'content.zip');
  writeFileSync(zipPath, pack.zip);

  // ---- 5. report ----
  const s = model.meta.stats;
  const { binary, tooLarge, missing } = pack.skipped;
  console.log(`${model.meta.name} @ ${headOid.slice(0, 10)}: ${s.files} files, ${s.units} units, ${s.edges} edges, ${model.tables.city.ids.length} cities, ${model.tables.district.ids.length} districts`);
  console.log(`snapshot  ${snapshotPath}  ${kb(statSync(snapshotPath).size)}`);
  console.log(`content   ${zipPath}  ${kb(statSync(zipPath).size)}  (${pack.entries} entries, ${kb(pack.rawBytes)} of text; every entry read back and verified)`);
  if (binary || tooLarge || missing) console.log(`not packed: ${binary} binary, ${tooLarge} over ${kb(config.parser.maxFileBytes)}, ${missing} with no committed blob`);
  if (!model.meta.demo?.sourceUrl) console.log('note: no source URL recorded (the clone has no origin remote); pass --source-url');
  const entry: DemoRepo = { name: args.name, path: `/demo/${args.name}/` };
  const location = model.meta.remoteUrl ?? model.meta.demo?.sourceUrl.replace(/^[a-z]+:\/\//i, '');
  if (location) entry.location = location;
  console.log(`add to config.json → demo.repos:\n  ${JSON.stringify(entry)}`);
}
