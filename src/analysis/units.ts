// Stage 2 — units (PLAN.md §5): a unit is the drawable sphere, one file or a header+implementation
// pair. The stage is "a mapping file → unit" plus a generic fold over it; header pairing
// (link/pairs.ts, the default in analyze) is one such UnitMapper.
import type { FileFacts } from '../contracts/lang';
import type { RawEdge } from './resolve';

/**
 * For each file (aligned with `files`), the path of its unit's primary file. A primary file must map
 * to itself; a file whose answer is not such a primary becomes a unit of its own.
 */
export type UnitMapper = (files: readonly FileFacts[], rawEdges: readonly RawEdge[]) => string[];

/** The plain mapping: every file is its own unit. */
export const oneUnitPerFile: UnitMapper = (files) => files.map((f) => f.path);

/** Units as columns, in id (path) order. Unit index = position in these arrays. */
export interface UnitTable {
  count: number;
  /** Unit id = its primary file's path. */
  ids: string[];
  primaryFile: string[];
  fileCount: number[];
  /** Sum over the unit's files. */
  loc: number[];
  bytes: number[];
  /** Language of the primary file, 'other' when no plug-in claims it. */
  lang: string[];
  /** Unit index per file, aligned with the file list the table was built from. */
  fileUnit: Int32Array;
  /** Unit index by file path, for every member file. */
  unitOfFile: Map<string, number>;
}

/** `files` must be in path order. */
export function buildUnits(
  files: readonly FileFacts[],
  rawEdges: readonly RawEdge[] = [],
  mapper: UnitMapper = oneUnitPerFile,
): UnitTable {
  const n = files.length;
  const mapped = mapper(files, rawEdges);
  const fileIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) fileIndex.set(files[i].path, i);

  // Settle each file's primary: the mapper's answer when that file exists and is its own primary.
  const primary = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const p = mapped[i] === files[i].path ? i : fileIndex.get(mapped[i]);
    primary[i] = p !== undefined && mapped[p] === files[p].path ? p : i;
  }

  // Primaries in file order are units in id order, because unit id = primary path.
  const unitOfPrimary = new Int32Array(n).fill(-1);
  const t: UnitTable = {
    count: 0, ids: [], primaryFile: [], fileCount: [], loc: [], bytes: [], lang: [],
    fileUnit: new Int32Array(n), unitOfFile: new Map(),
  };
  for (let i = 0; i < n; i++) {
    if (primary[i] !== i) continue;
    unitOfPrimary[i] = t.count++;
    t.ids.push(files[i].path);
    t.primaryFile.push(files[i].path);
    t.fileCount.push(0);
    t.loc.push(0);
    t.bytes.push(0);
    t.lang.push(files[i].lang ?? 'other');
  }
  for (let i = 0; i < n; i++) {
    const u = unitOfPrimary[primary[i]];
    t.fileUnit[i] = u;
    t.unitOfFile.set(files[i].path, u);
    t.fileCount[u]++;
    t.loc[u] += files[i].loc || 0;
    t.bytes[u] += files[i].bytes || 0;
  }
  return t;
}
