// "N files changed · Update" (PLAN.md §6.8, §12): work out what changed, re-run the fast and slow
// passes for those files only, and merge the results into the facts the pipeline holds. The caller
// (../post.ts `update`) then re-analyses with the existing ids and performs one animated re-layout;
// nothing here touches the store or physics.
import type { RepoAccess, RepoLocator } from '../../contracts/git';
import type { Manifest, ManifestEntry } from '../../contracts/ingest';
import type { FileFacts, SyntaxFacts } from '../../contracts/lang';
import type { RepoSource } from '../../contracts/pipeline';
import { buildManifest, runFastPass, runSlowPass } from '../../ingest';
import type { PipelineDeps, PipelineState } from '../core';
import { byPath, diffManifest, knownFiles } from './diff';
import type { ApplyUpdateOptions, KnownFile, UpdatePlan, UpdateResult, WorkingTreeChange, WorkingTreeInput } from './types';
import { checkWorkingTree, confirmWorkingTree } from './workingTree';

/**
 * What an update would do: the comparison of `previous` (what the map shows: `knownFiles(state, store)`,
 * a saved `{ path, oid }` list, or the manifest it was parsed from) with a freshly built manifest,
 * adjusted by an optional working-tree result. `count` is the N of "N files changed · Update".
 *
 * A file the working-tree check reports is read from disk rather than from git. The cases:
 * - missing on disk: taken off the map (and not re-added while it stays missing);
 * - its hash on disk is the oid the manifest lists: it is the staged blob after all, nothing special;
 * - its hash on disk is the oid the map already has (an earlier Update took it from disk), or it
 *   was not hashed and has the size the map has: still a disk file, but nothing to do;
 * - otherwise: re-parsed from the working tree.
 * Working-tree paths that the manifest does not list are ignored.
 */
export function planUpdate(previous: readonly KnownFile[] | Manifest, manifest: Manifest, workingTree?: WorkingTreeInput): UpdatePlan {
  const files: readonly KnownFile[] = Array.isArray(previous) ? previous : (previous as Manifest).entries;
  const diff = diffManifest(files, manifest);
  const shown = new Map<string, KnownFile>();
  for (const f of files) shown.set(f.path, f);
  const listed = new Map<string, string>();
  for (const e of manifest.entries) listed.set(e.path, e.oid);

  const reparse = new Set([...diff.added, ...diff.changed]);
  const drop = new Set(diff.removed);
  const fromDisk = new Map<string, WorkingTreeChange>();
  const missing = new Set<string>();
  for (const item of workingTree ?? []) {
    const change: WorkingTreeChange = typeof item === 'string' ? { path: item, oid: '' } : item;
    const { path } = change;
    if (!listed.has(path)) continue;
    const was = shown.get(path);
    if (change.missing) {
      missing.add(path);
      reparse.delete(path);
      if (was) drop.add(path);
    } else if (change.oid !== '' && change.oid === listed.get(path)) {
      continue;
    } else {
      fromDisk.set(path, change);
      const sameContent = change.oid !== ''
        ? was?.oid === change.oid
        : change.bytes !== undefined && was !== undefined && was.oid === '' && was.bytes === change.bytes;
      if (sameContent) reparse.delete(path);
      else reparse.add(path);
    }
  }
  return {
    manifest, diff, fromDisk,
    reparse: [...reparse].sort(byPath),
    drop: [...drop].sort(byPath),
    missing: [...missing].sort(byPath),
    count: reparse.size + drop.size,
  };
}

function locatorOf(source: RepoSource): RepoLocator | null {
  if (source.kind === 'directory') return source.locator;
  return source.kind === 'snapshot' ? source.locator ?? null : null;
}

function subManifest(manifest: Manifest, entries: ManifestEntry[]): Manifest {
  let totalBytes = 0;
  for (const e of entries) totalBytes += e.bytes;
  return { ...manifest, entries, totalBytes };
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The update was aborted.', 'AbortError');
}

/**
 * Bring `state.facts`, `state.syntax` and `state.manifest` (and `state.repo`) in line with the folder
 * as it is now, parsing as little as possible. Afterwards the caller runs
 * `analyzeAndApply(deps, state, { keepIds: true, extraMeta: result.meta })` and one animated re-layout.
 *
 * `workingTree` is what the working-tree check found (confirmWorkingTree's result, or bare paths from
 * checkWorkingTree); leave it out when there was no check. Those files are read from disk, never from
 * the pack, and under an empty oid so that nothing reaches the facts cache under the staged blob's oid.
 *
 * What is re-parsed is decided by the facts actually held, not by the plan: a file keeps its facts
 * only when they were parsed from the oid it has now. After a parse that is the changed and added
 * files. On a return visit the state holds no facts at all (the map came from a snapshot), so every
 * file goes through the passes, where the facts cache serves the unchanged ones without a read.
 * The slow pass likewise runs for every file without syntax facts of its current oid, and
 * `state.syntaxComplete` is true afterwards.
 *
 * Waits for a slow pass that is still running. Rejects, leaving the state untouched, when the folder
 * cannot be read, the fast pass fails or the signal aborts. A slow pass that fails outright is
 * reported in `slowPassError`, not thrown: call edges are an extra.
 */
export async function applyUpdate(deps: PipelineDeps, state: PipelineState, workingTree?: WorkingTreeInput, opts: ApplyUpdateOptions = {}): Promise<UpdateResult> {
  const { config, pool } = deps;
  const { signal } = opts;
  const lib = { buildManifest: opts.buildManifest ?? buildManifest, runFastPass: opts.runFastPass ?? runFastPass, runSlowPass: opts.runSlowPass ?? runSlowPass };
  // A running slow pass replaces state.syntax when it ends: let it, before merging into it.
  if (state.slowPass) await state.slowPass;

  let repo: RepoAccess | null = state.repo;
  const locator = locatorOf(state.source);
  if (locator && opts.reopen !== false) {
    await pool.setRepo(locator);
    repo = await deps.openRepo(locator);
  }
  if (!repo) throw new Error('This map has no folder to update from.');
  const fresh = opts.manifest ?? await lib.buildManifest(repo, config);
  if (fresh.entries.length === 0) throw new Error('No files to map were found in that folder.');

  const known = knownFiles(state, deps.store);
  let found = workingTree;
  if (!found && opts.checkWorkingTree) {
    found = await confirmWorkingTree(repo, await checkWorkingTree(repo, fresh, { signal }), config, { signal });
  }
  if (signal?.aborted) throw abortError(signal);
  const plan = planUpdate(known, fresh, found);

  // The manifest the map will have: the fresh one, minus files that are not on disk, with the
  // entries that are read from disk saying so.
  const heldFacts = new Map(state.facts.map((f) => [f.path, f]));
  const heldSyntax = new Map(state.syntax.map((s) => [s.path, s]));
  const missing = new Set(plan.missing);
  const entries: ManifestEntry[] = [];
  const diskPaths = new Set<string>();
  const toScan: ManifestEntry[] = [], toParse: ManifestEntry[] = [];
  for (const listed of fresh.entries) {
    if (missing.has(listed.path)) continue;
    const disk = plan.fromDisk.get(listed.path);
    const entry: ManifestEntry = disk
      ? { ...listed, oid: disk.oid, bytes: disk.bytes ?? listed.bytes, read: listed.read === 'none' ? 'none' : 'tree', packOffset: -1 }
      : listed;
    entries.push(entry);
    if (disk) diskPaths.add(entry.path);
    // The passes get a disk entry without an oid: no cache lookup, and nothing cached for it.
    const asRead = disk ? { ...entry, oid: '' } : entry;
    const current = entry.oid !== '';
    const factsKept = current && heldFacts.get(entry.path)?.oid === entry.oid;
    if (!factsKept) toScan.push(asRead);
    if (!(factsKept && heldSyntax.get(entry.path)?.oid === entry.oid)) toParse.push(asRead);
  }

  // `fresh` on the source means "do not trust what was cached", as in the first parse.
  const cache = state.source.kind === 'directory' && state.source.fresh ? undefined : deps.cache;
  const scanned = toScan.length
    ? await lib.runFastPass(subManifest(fresh, toScan), pool, config, { cache, signal, onProgress: (d, t) => opts.onProgress?.('fastPass', d, t) })
    : [];
  if (scanned.length !== toScan.length) throw new Error(`The fast pass returned ${scanned.length} results for ${toScan.length} files.`);
  let parsed: SyntaxFacts[] = [];
  let slowPassError: string | undefined;
  if (toParse.length) {
    try {
      parsed = await lib.runSlowPass(subManifest(fresh, toParse), pool, config, { cache, signal, onProgress: (d, t) => opts.onProgress?.('slowPass', d, t) });
    } catch (e) {
      slowPassError = e instanceof Error ? e.message : String(e);
    }
  }
  // The slow pass resolves with a partial result when aborted: that must not be merged.
  if (signal?.aborted) throw abortError(signal);

  const newFacts = new Map<string, FileFacts>();
  toScan.forEach((e, i) => newFacts.set(e.path, scanned[i]));
  const newSyntax = new Map(parsed.map((s) => [s.path, s]));

  // A file that was to be read from disk and could not be is gone (bare paths from checkWorkingTree
  // do not say which are missing). Believed only while the folder itself is readable.
  const vanished = new Set<string>();
  for (const path of diskPaths) if (newFacts.get(path)?.skipped === 'unreadable') vanished.add(path);
  if (vanished.size) {
    let root: unknown[] = [];
    try { root = await repo.tree.list(''); } catch { /* unreadable */ }
    if (root.length === 0) throw new Error('The folder can no longer be read, so the map was left as it is.');
  }

  // Merge, in manifest order. Results for disk entries come back without an oid; they take the
  // entry's (the hash of what was on disk, or '' when that is not known).
  const stamp = <T extends { oid: string }>(fact: T, oid: string): T => (fact.oid === oid ? fact : { ...fact, oid });
  const kept = entries.filter((e) => !vanished.has(e.path));
  const facts: FileFacts[] = [];
  const syntax: SyntaxFacts[] = [];
  const parsedPaths: string[] = [];
  for (const entry of kept) {
    const scannedNow = newFacts.get(entry.path);
    if (scannedNow) parsedPaths.push(entry.path);
    facts.push(scannedNow ? stamp(scannedNow, entry.oid) : heldFacts.get(entry.path)!);
    const parsedNow = newSyntax.get(entry.path);
    const held = scannedNow ? undefined : heldSyntax.get(entry.path);
    if (parsedNow) syntax.push(stamp(parsedNow, entry.oid));
    else if (held && held.oid === entry.oid) syntax.push(held);
  }
  const keptPaths = new Set(kept.map((e) => e.path));
  const dropped = [...new Set(known.map((k) => k.path).filter((p) => !keptPaths.has(p)))].sort(byPath);

  state.repo = repo;
  state.manifest = subManifest(fresh, kept);
  state.facts = facts;
  state.syntax = syntax;
  if (slowPassError === undefined) state.syntaxComplete = true;
  const result: UpdateResult = {
    plan, parsed: parsedPaths, kept: facts.length - parsedPaths.length, dropped,
    meta: { headOid: fresh.headOid, indexChecksum: fresh.indexChecksum },
  };
  if (slowPassError !== undefined) result.slowPassError = slowPassError;
  return result;
}
