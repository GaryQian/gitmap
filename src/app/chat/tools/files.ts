// search_files, get_file, get_dependencies, read_file: finding a file, the facts the map holds about
// it, the links around it, and its text.
import picomatch from 'picomatch';
import type { Config } from '../../../config';
import type { ModelReplica } from '../../../contracts/store';
import { fileRef, type EdgeKind } from '../../../model/types';
import { RECENCY_OLDER, buildAdjacency, computeReach, ownershipExtra, type Adjacency } from '../../../overlays';
import type { ToolOutcome } from '../contract';
import { CHAT_UI } from '../tunables';
import { fail, limitOf, ok, type Args } from './args';
import type { ToolEnv } from './env';
import { allPaths, cleanPath, findFile, placeOf, suggestFiles, type FileHit } from './lookup';
import { round2 } from './overview';

function unknownFile(replica: ModelReplica, raw: string): ToolOutcome {
  return fail(`No file "${cleanPath(raw)}" on the map.`, { nearest: suggestFiles(replica, raw) });
}

/** "city / district" names of a unit, with the district's ref for list_area and select. */
function whereabouts(replica: ModelReplica, unitSlot: number): { city?: string; district?: string; area?: string } {
  const { city, district } = placeOf(replica, unitSlot);
  return { ...(city ? { city: city.name } : {}), ...(district ? { district: district.name, area: district.ref } : {}) };
}

// ---- search_files ----

export async function searchFiles(args: Args, env: ToolEnv): Promise<ToolOutcome> {
  const { replica } = env;
  const query = (args.query as string).trim();
  if (query === '') return fail('"query" is empty.');
  const limit = limitOf(args.limit, CHAT_UI.searchDefault, CHAT_UI.searchMax);
  let paths: string[];
  try {
    // one more than asked for, to know whether the list was cut
    paths = (await env.search(query, limit + 1)).map((hit) => hit.path);
  } catch {
    const wanted = query.toLowerCase();
    paths = allPaths(replica).filter((p) => p.toLowerCase().includes(wanted)).slice(0, limit + 1);
  }
  const results = paths.slice(0, limit).map((path) => {
    const hit = findFile(replica, path);
    return { path, ...(hit ? whereabouts(replica, hit.unitSlot) : {}) };
  });
  return ok({
    query, results,
    ...(paths.length > limit ? { cut: 'more files match; narrow the query or raise limit' } : {}),
    ...(results.length === 0 ? { note: 'No file name or path matches.' } : {}),
  });
}

// ---- get_file ----

/** "name:count|name:count" → the names, most used first. */
function symbolNames(encoded: string | undefined): string[] {
  if (!encoded) return [];
  return encoded.split('|').map((part) => {
    const at = part.lastIndexOf(':');
    return { name: at < 0 ? part : part.slice(0, at), count: at < 0 ? 1 : Number(part.slice(at + 1)) || 1 };
  }).filter((s) => s.name !== '').sort((a, b) => b.count - a.count).slice(0, CHAT_UI.symbols).map((s) => s.name);
}

interface Link { path: string; kind: EdgeKind; weight: number; symbols: string[] }

function links(replica: ModelReplica, unitSlot: number): { dependencies: Link[]; dependents: Link[] } {
  const edges = replica.table('edge'), units = replica.table('unit');
  const src = edges.refSlots.src ?? [], dst = edges.refSlots.dst ?? [];
  const dependencies: Link[] = [], dependents: Link[] = [];
  for (let e = 0; e < edges.capacity; e++) {
    if (edges.ids[e] == null || src[e] === dst[e]) continue;
    const other = src[e] === unitSlot ? dst[e]! : dst[e] === unitSlot ? src[e]! : -1;
    const path = other < 0 ? null : units.ids[other];
    if (path == null) continue;
    (src[e] === unitSlot ? dependencies : dependents).push({
      path, kind: edges.cols.kind[e] ?? 'import', weight: edges.cols.weight[e] ?? 1, symbols: symbolNames(edges.cols.symbols[e]),
    });
  }
  const strongest = (a: Link, b: Link) => b.weight - a.weight || (a.path < b.path ? -1 : 1);
  return { dependencies: dependencies.sort(strongest), dependents: dependents.sort(strongest) };
}

const isoDay = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

/** What the history layers know about one unit; null when they hold nothing for it. */
function historyOf(replica: ModelReplica, unitSlot: number, unitId: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const known = (v: number | undefined): v is number => v !== undefined && v === v;

  const recency = replica.layers.get('recency')?.values[unitSlot];
  if (known(recency)) out.lastChanged = recency <= RECENCY_OLDER ? 'before the history that was walked' : isoDay(recency);

  const ownership = replica.layers.get('ownership');
  const commits = ownership?.values[unitSlot];
  if (known(commits)) out.commits = commits;
  const extra = ownershipExtra(ownership);
  const row = extra ? extra.unitIds.indexOf(unitId) : -1;
  if (extra && row >= 0) {
    const names = new Map(extra.contributors.map((c) => [c.id, c.name]));
    const authors: { name: string; commits: number }[] = [];
    let total = 0;
    for (let i = extra.offsets[row]!; i < extra.offsets[row + 1]!; i++) {
      const n = extra.authorCommits[i] ?? 0;
      total += n;
      authors.push({ name: names.get(extra.authorIds[i]!) ?? `contributor ${extra.authorIds[i]}`, commits: n });
    }
    authors.sort((a, b) => b.commits - a.commits);
    if (authors.length > 0) {
      out.authors = authors.slice(0, CHAT_UI.authors).map((a) => ({ ...a, share: total > 0 ? round2(a.commits / total) : 0 }));
      if (authors.length > CHAT_UI.authors) out.moreAuthors = authors.length - CHAT_UI.authors;
    }
  }

  const risk = replica.layers.get('knowledgeRisk')?.values[unitSlot];
  if (known(risk)) out.topAuthorShare = round2(risk);
  return Object.keys(out).length > 0 ? out : null;
}

function notesOn(replica: ModelReplica, unitId: string): { type: string; text: string; label?: string }[] {
  const ref = `u:${unitId}`;
  const out: { type: string; text: string; label?: string }[] = [];
  for (const a of replica.annotations) {
    if (a.type === 'poi' && a.parent === ref) out.push({ type: 'point of interest', label: a.label, text: a.summary });
    else if (a.type === 'tour') a.steps.forEach((step, i) => { if (step.parent === ref) out.push({ type: `tour step ${i + 1}`, text: step.text }); });
    else if (a.type === 'summary' && a.parent === ref) out.push({ type: 'summary', text: a.text });
  }
  return out;
}

export function getFile(args: Args, env: ToolEnv): ToolOutcome {
  const { replica } = env;
  const hit = findFile(replica, args.path as string);
  if (!hit) return unknownFile(replica, args.path as string);
  const files = replica.table('file'), units = replica.table('unit');
  const u = hit.unitSlot;
  const lang = (hit.fileSlot >= 0 ? files.cols.lang[hit.fileSlot] : units.cols.lang[u]) ?? 'other';
  const language = replica.meta?.languages?.[lang]?.name ?? lang;
  const base = {
    path: hit.path, language, lang,
    lines: (hit.fileSlot >= 0 ? files.cols.loc[hit.fileSlot] : units.cols.loc[u]) ?? 0,
  };
  if (u < 0) return ok({ ...base, note: 'This file is not part of the dependency map, so there is nothing more to say about it.' });

  const unitId = units.ids[u]!;
  const { city, district } = placeOf(replica, u);
  const { dependencies, dependents } = links(replica, u);
  const edgesKnown = replica.table('edge').count > 0;
  const top = (list: Link[]) => list.slice(0, CHAT_UI.neighbours).map((l) => ({ path: l.path, kind: l.kind, ...(l.symbols.length ? { symbols: l.symbols } : {}) }));
  const others = (units.cols.fileCount[u] ?? 1) > 1
    ? allPaths(replica).filter((p) => p !== hit.path && files.refSlots.unit?.[files.slotOf(p)] === u)
    : [];
  const history = historyOf(replica, u, unitId);
  const notes = notesOn(replica, unitId);

  return ok({
    ...base,
    ...(others.length ? { sameUnit: others } : {}),
    ...(city ? { city: { ref: city.ref, name: city.name } } : {}),
    ...(district ? { district: { ref: district.ref, name: district.name } } : {}),
    importance: round2(units.cols.importancePct[u] ?? 0),
    // the columns are right before the links have arrived, and the links are right once they have
    dependedOnBy: edgesKnown ? dependents.length : units.cols.fanIn[u] ?? 0,
    dependsOn: edgesKnown ? dependencies.length : units.cols.fanOut[u] ?? 0,
    dependencies: top(dependencies),
    dependents: top(dependents),
    ...(history ? { history } : { history: 'not known for this file' }),
    ...(notes.length ? { notes } : {}),
  });
}

// ---- get_dependencies ----

const graphs = new WeakMap<ModelReplica, Adjacency>();

/** The unit graph, rebuilt only when the replica has moved on. */
export function adjacencyOf(replica: ModelReplica): Adjacency {
  let graph = graphs.get(replica);
  if (!graph || graph.rev !== replica.rev) graphs.set(replica, graph = buildAdjacency(replica));
  return graph;
}

export function getDependencies(args: Args, env: ToolEnv): ToolOutcome {
  const { replica } = env;
  const hit = findFile(replica, args.path as string);
  if (!hit) return unknownFile(replica, args.path as string);
  const depth = (args.depth as number | undefined) ?? 1;
  if (depth < 1 || depth > 3) return fail('"depth" must be 1, 2 or 3.');
  const limit = limitOf(args.limit, CHAT_UI.listDefault, CHAT_UI.listMax);
  const direction = args.direction as 'depends_on' | 'depended_on_by';
  if (hit.unitSlot < 0) return ok({ path: hit.path, direction, depth, total: 0, files: [], note: 'This file is not part of the dependency map.' });

  const units = replica.table('unit');
  const hops = computeReach(adjacencyOf(replica), [hit.unitSlot], direction === 'depends_on' ? 'dependsOn' : 'dependedOnBy', depth);
  const reached: number[] = [];
  for (let s = 0; s < hops.length; s++) if (hops[s]! > 0 && units.ids[s] != null) reached.push(s);
  // nearest first; within a hop, the files more of the repo leans on
  reached.sort((a, b) => hops[a]! - hops[b]! || (units.cols.importancePct[b] ?? 0) - (units.cols.importancePct[a] ?? 0) || a - b);
  return ok({
    path: hit.path, direction, depth, total: reached.length,
    files: reached.slice(0, limit).map((s) => ({ path: units.ids[s]!, hops: hops[s]!, ...whereabouts(replica, s) })),
    ...(reached.length > limit ? { cut: `${reached.length - limit} more not listed; raise limit to see them` } : {}),
  });
}

// ---- read_file ----

const secretMatchers = new WeakMap<Config, (path: string) => boolean>();

/** Files that are never sent to the model, by name: config.ai.excludePaths, as the digest applies it. */
export function isSecretPath(config: Config, path: string): boolean {
  let match = secretMatchers.get(config);
  if (!match) {
    const globs = config.ai.excludePaths.map((g) => (g.includes('/') ? g : `**/${g}`));
    match = globs.length ? picomatch(globs, { dot: true, windows: false, nocase: true }) : () => false;
    secretMatchers.set(config, match);
  }
  return match(path);
}

/** Key-shaped content that must not leave the machine whatever the file is called. */
const KEY_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  /\b(?:sk-ant-[\w-]{16}|sk-proj-[\w-]{16}|sk-[A-Za-z0-9]{24}|[sr]k_live_[A-Za-z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30}|github_pat_\w{20}|glpat-[\w-]{16}|xox[abposr]-[A-Za-z0-9-]{10}|A[KS]IA[0-9A-Z]{16}|AIza[\w-]{30})/,
  /(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*["'][\w+/=.-]{16,}["']/i,
];
export const looksSecret = (text: string): boolean => KEY_SHAPES.some((shape) => shape.test(text));

function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, CHAT_UI.binarySniffBytes);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

export async function readFile(args: Args, env: ToolEnv, signal?: AbortSignal): Promise<ToolOutcome> {
  const { replica } = env;
  const hit: FileHit | null = findFile(replica, args.path as string);
  if (!hit) return unknownFile(replica, args.path as string);
  const start = (args.start_line as number | undefined) ?? 1;
  const endAsked = args.end_line as number | undefined;
  if (start < 1) return fail('"start_line" must be 1 or more.');
  if (endAsked !== undefined && endAsked < start) return fail('"end_line" must not be before "start_line".');
  if (isSecretPath(env.config, hit.path)) return fail(`${hit.path} is kept out of AI requests by its name (it may hold secrets), so its contents cannot be read here.`);
  if (!env.content) return fail('File contents are not available for this map: it was opened without its folder. Answer from the map instead.');

  let bytes: Uint8Array;
  try {
    bytes = await env.content.read(fileRef(hit.path));
  } catch {
    return fail(`${hit.path} could not be read. Its contents may not be available for this map.`);
  }
  if (signal?.aborted) return fail('Stopped.');
  if (isBinary(bytes)) return fail(`${hit.path} is not a text file.`);
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
  if (looksSecret(text)) return fail(`${hit.path} appears to contain a key or password, so its contents are not sent.`);

  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  if (total === 0) return { ok: true, content: `${hit.path} is empty.` };
  if (start > total) return fail(`${hit.path} has ${total} lines; "start_line" ${start} is past the end.`);

  const wanted = Math.min(total, endAsked ?? total);
  let end = Math.min(wanted, start + CHAT_UI.readLines - 1);
  const width = String(end).length;
  const body: string[] = [];
  let chars = 0;
  for (let n = start; n <= end; n++) {
    const raw = lines[n - 1]!;
    const line = raw.length > CHAT_UI.readLineChars ? `${raw.slice(0, CHAT_UI.readLineChars)}… (line cut)` : raw;
    chars += line.length + width + 3;
    if (chars > CHAT_UI.readChars && body.length > 0) { end = n - 1; break; }
    body.push(`${String(n).padStart(width)}  ${line}`);
  }
  const whole = start === 1 && end === total;
  const head = whole
    ? `${hit.path}, all ${total} lines`
    : `${hit.path}, lines ${start} to ${end} of ${total}${end < wanted ? ` (cut: ask for start_line ${end + 1} to read on)` : ''}`;
  return { ok: true, content: `${head}\n${body.join('\n')}` };
}
