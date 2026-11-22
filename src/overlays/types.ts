// Shared overlay vocabulary (PLAN.md §10). Main-thread safe: nothing here reaches parsers or plug-ins.
import type { LayerDef } from '../model/types';

export type OverlayId = 'recency' | 'ownership' | 'reach' | 'knowledgeRisk' | 'tests';

// ---- history facts: the input the layer builders take (an adapter fills it from the history walk) ----

/** Per-file history facts (PLAN.md §6.5). Times are in seconds. */
export type FileHistory = {
  lastModified: number;
  firstSeen: number;
  commits: number;
  authors: [contributorId: number, commits: number][];
};

export type HistoryContributor = { id: number; name: string; commits: number };

/** What the history walk knows so far. May be partial; builders can be called again as chunks land. */
export type HistoryInput = {
  contributors: HistoryContributor[];
  /** By repo-relative file path. */
  files: Map<string, FileHistory> | Record<string, FileHistory>;
  /** Share of the commit window walked, 0..1. */
  coverage: number;
  /** The whole window has been walked. */
  complete: boolean;
  /** Every current file has been seen once (Recency finishes early, PLAN.md §3.1). */
  recencyComplete: boolean;
  /** Seconds. */
  now: number;
};

// ---- layer conventions ----

/** Recency value of a unit the finished walk never saw: older than the commit window. */
export const RECENCY_OLDER = 0;

/** Tests layer categories. */
export const TESTS = { test: 0, covered: 1, uncovered: 2 } as const;
/**
 * What the Tests overlay shows, from tested to untested. The layer stores the three TESTS values;
 * the overlay splits "uncovered" in two with the unit graph: `near` for a unit one hop from a
 * covered one. Worked out when the overlay is drawn, so saved maps and demos show it too.
 */
export const TESTS_SHOWN = { test: 0, covered: 1, near: 2, uncovered: 3 } as const;

/**
 * Ownership side data (`Layer.extra`): per-unit author counts in CSR form. Unit r of `unitIds` has
 * authors `authorIds[offsets[r] .. offsets[r + 1])` with matching `authorCommits`. Plain arrays, so
 * it survives structured clone and JSON. Always covers every unit with history (never a delta).
 */
export type OwnershipExtra = {
  unitIds: string[];
  offsets: number[];
  authorIds: number[];
  authorCommits: number[];
  /** Sorted by commits, most first. */
  contributors: HistoryContributor[];
};

export const LAYER_DEFS: Record<Exclude<OverlayId, 'reach'>, LayerDef> = {
  // values: last-modified time in seconds (RECENCY_OLDER = before the window). The domain is replaced per patch.
  recency: { id: 'recency', kind: 'scalar', label: 'Recency', domain: [0, 1], colormap: 'recency' },
  // values: total commits per unit; the ramp runs over one contributor's share, 0..1
  ownership: { id: 'ownership', kind: 'parametric', label: 'Ownership', domain: [0, 1], colormap: 'ownership' },
  // values: the top author's share of commits, 0..1
  knowledgeRisk: { id: 'knowledgeRisk', kind: 'scalar', label: 'Knowledge risk', domain: [0, 1], colormap: 'knowledgeRisk' },
  // values: TESTS.test | TESTS.covered | TESTS.uncovered
  tests: { id: 'tests', kind: 'categorical', label: 'Tests', domain: [0, 2], colormap: 'tests' },
};
