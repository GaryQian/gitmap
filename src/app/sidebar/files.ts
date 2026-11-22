// Which files the reader shows for an opened node: the file itself and, for a header +
// implementation pair, its unit's other files as tabs (PLAN.md §5). Pure, no React.
import type { ModelReplica } from '../../contracts/store';
import { parseRef, type NodeRef } from '../../model/types';
import { basename, dirname } from '../../shared';

export interface ReaderFile {
  /** Repo-relative path: the file's id. */
  path: string;
  name: string;
  /** Directory part of the path, '' at the repo root. */
  dir: string;
  /** Language id from the model; 'other' when unknown. */
  lang: string;
  /** Line count from the model; 0 when unknown. */
  loc: number;
}

export interface ReaderTarget {
  /** One entry per tab, the unit's primary file first. Never empty. */
  files: ReaderFile[];
  /** Index in `files` of the file the ref asks for. */
  active: number;
}

/**
 * The reader's tabs for `ref`. A `u:` ref asks for the unit's primary file; an `f:` ref asks for that
 * file, with the rest of its unit beside it. A file the model does not know still opens, alone, by
 * its path. Null for a city or district ref, or a malformed one.
 */
export function resolveTarget(replica: ModelReplica | null, ref: NodeRef): ReaderTarget | null {
  let parsed;
  try { parsed = parseRef(ref); } catch { return null; }
  if (parsed.kind !== 'file' && parsed.kind !== 'unit') return null;
  if (parsed.id === '') return null;

  const files = replica?.table('file');
  const units = replica?.table('unit');

  let unitId: string;
  let asked: string;
  if (parsed.kind === 'unit') {
    unitId = parsed.id;
    const u = units?.slotOf(unitId) ?? -1;
    asked = (u >= 0 && units?.cols.primaryFile[u]) || unitId;
  } else {
    asked = parsed.id;
    const f = files?.slotOf(asked) ?? -1;
    unitId = f >= 0 ? (files?.cols.unit[f] ?? '') : '';
  }
  const u = unitId === '' ? -1 : (units?.slotOf(unitId) ?? -1);
  const primary = (u >= 0 && units?.cols.primaryFile[u]) || unitId || asked;

  const paths = new Set<string>([asked]);
  if (files && unitId !== '') {
    const owner = files.cols.unit;
    for (let f = 0; f < files.capacity; f++) {
      const id = files.ids[f];
      if (id != null && owner[f] === unitId) paths.add(id);
    }
  }
  const ordered = [...paths].sort((a, b) => (a === primary ? -1 : b === primary ? 1 : a < b ? -1 : a > b ? 1 : 0));

  return {
    files: ordered.map((path): ReaderFile => {
      const f = files?.slotOf(path) ?? -1;
      return {
        path, name: basename(path), dir: dirname(path),
        lang: f >= 0 ? (files?.cols.lang[f] ?? 'other') : 'other',
        loc: f >= 0 ? (files?.cols.loc[f] ?? 0) : 0,
      };
    }),
    active: ordered.indexOf(asked),
  };
}

/** True for the files that get a rendered preview. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}
