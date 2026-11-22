// The re-parse set by blob oid (PLAN.md §6.3 "an update only re-parses files whose OID changed").
import type { Manifest } from '../../contracts/ingest';
import type { FileFacts } from '../../contracts/lang';
import type { ModelStore } from '../../contracts/store';
import type { KnownFile, ManifestDiff } from './types';

/** Plain code-unit order, the order manifest entries are sorted in. */
export const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Compare what the map knows with a fresh manifest.
 *
 * An empty oid (a plain folder, an untracked file, a file last read from disk without hashing it)
 * says nothing about content, so a path with an empty oid on either side is reported as `changed`:
 * re-parsing an unchanged file is harmless, missing an edit is not. When a path is listed twice in
 * `previousFiles` the last one counts.
 */
export function diffManifest(previousFiles: readonly KnownFile[], manifest: Manifest): ManifestDiff {
  const previous = new Map<string, string>();
  for (const f of previousFiles) previous.set(f.path, f.oid ?? '');
  const diff: ManifestDiff = { added: [], changed: [], removed: [], unchanged: [] };
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const oid = previous.get(entry.path);
    if (oid === undefined) diff.added.push(entry.path);
    else if (oid === '' || entry.oid === '' || oid !== entry.oid) diff.changed.push(entry.path);
    else diff.unchanged.push(entry.path);
  }
  for (const path of previous.keys()) if (!seen.has(path)) diff.removed.push(path);
  diff.added.sort(byPath);
  diff.changed.sort(byPath);
  diff.removed.sort(byPath);
  diff.unchanged.sort(byPath);
  return diff;
}

/**
 * The files the map shows now, with the oid each was parsed from: the facts held from this
 * session's parse, or, when the map came from a snapshot and nothing was parsed (the return visit,
 * PLAN.md §12), the model's file table.
 */
export function knownFiles(state: { facts: readonly FileFacts[] }, store: Pick<ModelStore, 'replica'>): KnownFile[] {
  if (state.facts.length) return state.facts.map((f) => ({ path: f.path, oid: f.oid ?? '', bytes: f.bytes }));
  const files = store.replica.table('file');
  const out: KnownFile[] = [];
  for (const slot of files.slots()) out.push({ path: files.ids[slot]!, oid: files.cols.oid[slot] ?? '', bytes: files.cols.bytes[slot] });
  return out;
}
