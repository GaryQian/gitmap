// Build a package (plan/DEMO-MODE.md) without the browser: the same parse, cluster and layout
// pipeline as the app, headless, written by the same writer as the app's Export button.
//
//   <out>/<name>.starmap.zip     the map and the text of its files, as one package
//
// With --ai it also does the AI work the app's Export does: city summaries, points of interest, the
// tour and every detail card, through the same handlers the app's /api/ai routes use. That needs the
// provider's key in the environment, which is where the dev server reads it from too:
//
//   node --env-file=.env.local scripts/run.mjs scripts/build-demo.ts ../react --ai
//
// Without --ai the package has no AI notes (its manifest says `ai: "none"`): a test fixture.
//
// Usage: node scripts/run.mjs scripts/build-demo.ts <local clone> [--name react] [--out public/demo]
//          [--source-url URL] [--max-bytes N] [--min-lines N] [--no-history] [--history-seconds N]
//          [--ai] [--allow-partial-ai]
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { createAiClient } from '../src/ai';
import { createDeps, handlers, type RouteName } from '../src/ai/server';
import { config as baseConfig, withConfig, type Config, type DemoRepo } from '../src/config';
import { DETAIL_QUESTIONS, type DetailQuestion } from '../src/contracts/ai';
import { licenseOf, readPackage, sourceUrlOf, writePackage, PACKAGE_SUFFIX, type PackageSink } from '../src/content';
import type { RepoLocator } from '../src/contracts/git';
import { openNodeRepoAccess } from '../src/git/node';
import { decodeModel } from '../src/model';
import type { Poi, RepoModel } from '../src/model/types';
import type { PipelineDeps } from '../src/pipeline/core';
import { createFileReader } from '../src/pipeline/exportFiles';
import { runHeadless, type HeadlessResult } from '../src/pipeline/node';

interface Args {
  rootPath: string;
  name: string;
  out: string;
  sourceUrl: string | null;
  maxBytes: number;
  minLines: number;
  history: boolean;
  /** Walk history for this long instead of the app's default budget, with no commit cap. */
  historySeconds: number | null;
  ai: boolean;
  allowPartialAi: boolean;
}

const USAGE = 'usage: node scripts/run.mjs scripts/build-demo.ts <local clone> [--name react] [--out public/demo] [--source-url URL] [--max-bytes N] [--min-lines N] [--no-history] [--history-seconds N] [--ai] [--allow-partial-ai]';
const VALUE_FLAGS = new Set(['--name', '--out', '--source-url', '--max-bytes', '--min-lines', '--history-seconds']);
const BOOLEAN_FLAGS = new Set(['--no-history', '--ai', '--allow-partial-ai']);

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
  // the name becomes a file name and part of a URL
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`--name must be letters, digits, '.', '_' or '-': got "${name}"`);
  const count = (flag: string, fallback: number): number => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a number, 0 or more: got "${raw}"`);
    return Math.floor(n);
  };
  return {
    rootPath, name,
    out: path.resolve(values.get('--out') ?? 'public/demo'),
    sourceUrl: values.get('--source-url') ?? null,
    maxBytes: count('--max-bytes', baseConfig.demo.package.maxBytes),
    minLines: count('--min-lines', baseConfig.demo.package.minLines),
    history: !flags.has('--no-history'),
    historySeconds: values.has('--history-seconds') ? count('--history-seconds', 0) : null,
    ai: flags.has('--ai'),
    allowPartialAi: flags.has('--allow-partial-ai'),
  };
}

/** The archive goes straight to disk, a chunk at a time. */
function fileSink(file: string): PackageSink {
  const fd = openSync(file, 'w');
  let open = true;
  const close = () => { if (open) { open = false; closeSync(fd); } };
  return {
    write(chunk) { writeSync(fd, chunk); },
    close,
    abort() { close(); try { unlinkSync(file); } catch { /* nothing was written */ } },
  };
}

// ---- the AI work (plan/DEMO-MODE.md §3, step 2) ----

/** The app's own /api/ai handlers, called in this process. The key comes from the environment. */
function aiClient(config: Config) {
  const deps = {
    ...createDeps(process.env, config),
    // the limiter protects a public endpoint from strangers; this is the developer's own build
    limiter: { hit: async () => ({ allowed: true, count: 0, retryAfterMs: 0 }) },
  };
  return createAiClient({
    fetch: (async (url: unknown, init?: RequestInit) =>
      handlers[String(url).split('/').pop() as RouteName](new Request(`http://local${String(url)}`, init), deps)) as typeof fetch,
  });
}

const QUESTIONS = Object.keys(DETAIL_QUESTIONS) as DetailQuestion[];
const poisOf = (result: HeadlessResult): Poi[] => result.store.replica.annotations.filter((a): a is Poi => a.type === 'poi');
const missingDetails = (result: HeadlessResult): { poi: Poi; question: DetailQuestion }[] =>
  poisOf(result).flatMap((poi) => QUESTIONS.filter((q) => poi.details?.[q]?.status !== 'ready').map((question) => ({ poi, question })));

/** How much of the AI work a model carries, for the manifest. */
function aiState(model: RepoModel): 'complete' | 'partial' | 'none' {
  const { summaries, pois, tours } = model.annotations;
  const tour = tours[0] ?? null; // a model carries at most one tour
  const some = summaries.length > 0 || pois.length > 0 || tour !== null;
  if (!some) return 'none';
  const details = pois.every((p) => QUESTIONS.every((q) => p.details?.[q]?.status === 'ready'));
  return summaries.length > 0 && pois.length > 0 && tour !== null && details ? 'complete' : 'partial';
}

/** Summaries, points of interest and the tour, then every detail card, three at a time; one more pass for what failed. */
async function writeAiNotes(result: HeadlessResult, read: (paths: string[]) => Promise<(Uint8Array | null)[]>, log: (line: string) => void): Promise<string[]> {
  const problems: string[] = [];
  const outcome = await result.ai.start();
  if (outcome.failure) problems.push(`notes: ${outcome.failure.message}`);
  const a = result.store.replica.annotations;
  log(`AI notes: ${a.filter((x) => x.type === 'summary').length} summaries, ${poisOf(result).length} points of interest, tour ${a.some((x) => x.type === 'tour') ? 'written' : 'missing'}`);
  for (let pass = 0; pass < 2; pass++) {
    const jobs = missingDetails(result);
    if (jobs.length === 0) break;
    log(`AI detail cards: ${jobs.length} to write${pass ? ' (second try)' : ''}`);
    let next = 0, done = 0;
    const failures: string[] = [];
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (;;) {
        const job = jobs[next++];
        if (!job) return;
        const path = job.poi.parent.slice(2);
        const [bytes] = await read([path]);
        const text = bytes ? new TextDecoder().decode(bytes) : null;
        const { failure } = await result.ai.detail(job.poi.id, job.question, text);
        if (failure) failures.push(`${job.poi.label} / ${job.question}: ${failure.message}`);
        if (++done % 10 === 0 || done === jobs.length) log(`AI detail cards ${done} / ${jobs.length}`);
      }
    }));
    if (pass === 1) problems.push(...failures);
  }
  const left = missingDetails(result).length;
  if (left) problems.push(`${left} detail cards are still missing`);
  return problems;
}

const mb = (bytes: number): string => `${(bytes / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB`;
const count = (n: number): string => n.toLocaleString('en-US');

export default async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const config = args.historySeconds === null ? baseConfig
    : withConfig({ history: { timeBudgetSeconds: args.historySeconds, maxCommits: 1_000_000_000 } });
  const t0 = performance.now();
  const at = (): string => `[${((performance.now() - t0) / 1000).toFixed(1)}s]`;

  // ---- 1. parse, cluster, lay out, walk history ----
  let lastStage = '';
  const result = await runHeadless({ kind: 'directory', locator: { kind: 'node', rootPath: args.rootPath } }, config, {
    history: args.history,
    aiClient: args.ai ? aiClient(config) : undefined,
    onEvent(evt, payload) {
      if (evt !== 'stage') return;
      const s = payload as { stage: string; label: string };
      if (s.stage !== lastStage) { lastStage = s.stage; console.log(`${at()} ${s.stage} ${s.label}`); }
    },
  });

  try {
    const openRepo = async (locator: RepoLocator) => {
      if (locator.kind !== 'node') throw new Error(`cannot open a '${locator.kind}' locator here`);
      return openNodeRepoAccess(locator.rootPath);
    };
    // the reader needs the store (blob ids) and a way to open the folder; nothing else of the pipeline
    const read = createFileReader({ store: result.store, openRepo } as unknown as PipelineDeps, result.state);

    // ---- 1b. the AI work, when asked for ----
    let finished = result.model;
    if (args.ai) {
      const problems = await writeAiNotes(result, read, (line) => console.log(`${at()} ${line}`));
      finished = await result.finish();
      for (const p of problems) console.log(`AI problem: ${p}`);
      if (aiState(finished) !== 'complete' && !args.allowPartialAi) {
        throw new Error('The AI notes are not complete (see the problems above). Nothing was written; run again, or pass --allow-partial-ai to package what there is.');
      }
    }
    // the package is named for the demo, whatever the clone's folder is called
    const model = { ...finished, meta: { ...finished.meta, name: args.name } };
    const ai = aiState(model);

    // ---- 2. the licence: a package republishes the repo's files ----
    const license = await licenseOf(read);
    console.log(`${at()} licence: ${license}`);
    if (license === 'unknown') console.log('note: the licence was not recognised. Check that it allows republishing the files before shipping this package.');
    const sourceUrl = args.sourceUrl ?? sourceUrlOf(model.meta.remoteUrl);
    if (!sourceUrl) console.log('note: no source URL recorded (the clone has no origin remote); pass --source-url');

    // ---- 3. the package ----
    mkdirSync(args.out, { recursive: true });
    const file = path.join(args.out, args.name + PACKAGE_SUFFIX);
    let shown = 0;
    const report = await writePackage({
      model, read, sink: fileSink(file),
      info: { sourceUrl, license, ai },
      maxBytes: args.maxBytes, minLines: args.minLines, maxFileBytes: config.parser.maxFileBytes,
      onProgress(done, total, bytes) {
        const now = performance.now();
        if (now - shown < 2000 && done < total) return;
        shown = now;
        console.log(`${at()} packing ${count(done)} / ${count(total)} · ${mb(bytes)}`);
      },
    });

    // ---- 4. read it back with the app's own reader ----
    const size = statSync(file).size;
    const blob = new Blob([readFileSync(file)]);
    const files = model.tables.file;
    const oids = new Map(files.ids.map((id, row) => [id, files.cols.oid![row] ?? '']));
    const opened = await readPackage(blob, { oidOf: (p) => oids.get(p) || null });
    const back = await decodeModel(opened.map);
    if (back.tables.unit.ids.length !== model.tables.unit.ids.length) throw new Error('package check failed: the map did not read back whole');
    let checked = 0;
    for (const id of files.ids) {
      if (!opened.content.has(id)) continue;
      await opened.content.read(`f:${id}`); // rejects when the bytes do not hash to the map's blob id
      checked++;
    }
    if (checked !== report.packedFiles) throw new Error(`package check failed: ${report.packedFiles} files were packed but ${checked} read back`);

    // ---- 5. report ----
    const s = model.meta.stats;
    console.log(`${args.name} @ ${(model.meta.headOid ?? '').slice(0, 10) || 'no commit'}: ${count(s.files)} files, ${count(s.units)} units, ${count(s.edges)} edges, ${model.tables.city.ids.length} cities, ${model.tables.district.ids.length} districts`);
    console.log(`package   ${file}  ${mb(size)}  (${count(report.packedFiles)} files, ${mb(report.rawBytes)} of text; every one read back and verified)`);
    const left: string[] = [];
    if (report.trimmedFiles) left.push(`${count(report.trimmedFiles)} trimmed for size`);
    if (report.skippedFiles) left.push(`${count(report.skippedFiles)} binary or over ${mb(config.parser.maxFileBytes)}`);
    if (report.unreadableFiles) left.push(`${count(report.unreadableFiles)} unreadable or changed since the parse`);
    if (left.length) console.log(`left out: ${left.join(', ')}`);
    const notes = model.annotations;
    console.log(ai === 'none'
      ? 'AI: none (pass --ai to include summaries, points of interest, the tour and the detail cards)'
      : `AI: ${ai} (${notes.summaries.length} summaries, ${notes.pois.length} points of interest, ${notes.tours[0]?.steps.length ?? 0} tour steps)`);
    const entry: DemoRepo = { name: args.name, file: `/demo/${args.name}${PACKAGE_SUFFIX}` };
    const location = sourceUrl.replace(/^[a-z]+:\/\//i, '');
    if (location) entry.location = location;
    console.log(`add to config.json → demo.repos:\n  ${JSON.stringify(entry)}`);
  } finally {
    result.dispose();
  }
}
