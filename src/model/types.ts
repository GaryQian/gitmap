// The data model and the patch protocol (PLAN.md §5, §5.1). Lead-owned: changes go through the lead.
//
// Vocabulary
//   id    permanent string identity. File id = repo-relative path with '/' separators. Unit id = its
//         primary file's path. District and city ids are minted opaque strings. Edge id = edgeId(src, dst).
//   slot  dense integer assigned by the ModelStore, used to index GPU buffers and physics buffers.
//         Slots are per-session and per-kind; a removed entity leaves a hole that may be reused.
//   ref   NodeRef, a kind-prefixed id used by UI state, annotations and commands.

export type LangId = string;
export type NodeRef = `f:${string}` | `u:${string}` | `d:${string}` | `c:${string}`;
export type EdgeKind = 'import' | 'call' | 'reference' | 'inherit' | 'bridge';
export type EntityKind = 'file' | 'unit' | 'edge' | 'district' | 'city' | 'contributor';
export const ENTITY_KINDS: readonly EntityKind[] = ['city', 'district', 'unit', 'file', 'edge', 'contributor'];

/** Built-in overlay layers; other ids are allowed. */
export type LayerId = 'recency' | 'ownership' | 'reach' | 'knowledgeRisk' | 'tests' | (string & {});
export type Subsystem =
  | 'manifest' | 'fastPass' | 'slowPass' | 'resolve' | 'cluster' | 'layout'
  | 'history' | 'workingTree' | 'ai' | 'snapshot';

/**
 * Columns per entity kind. Every column is a flat array with one value per row, so chunks are
 * trivially serialisable. Reference columns (marked →) hold ids of another kind; '' means "none".
 */
export interface EntityColumns {
  file: {
    lang: string[];        // LangId, or 'other'
    bytes: number[];
    loc: number[];
    oid: string[];         // git blob oid, '' when unknown
    unit: string[];        // → unit
  };
  unit: {
    primaryFile: string[]; // → file (same string as the unit id)
    fileCount: number[];   // 1, or 2 for a header + implementation pair
    loc: number[];         // sum over its files
    bytes: number[];
    lang: string[];        // LangId of the primary file
    importancePct: number[]; // 0..1 percentile across the repo
    fanIn: number[];
    fanOut: number[];
    district: string[];    // → district
  };
  edge: {
    src: string[];         // → unit (the dependent: importer, caller)
    dst: string[];         // → unit (the dependency: imported, callee)
    kind: EdgeKind[];      // strongest relation on this pair
    weight: number[];      // 1 per import + log(1 + referenceCount)
    confidence: number[];  // 0..1
    mechanism: string[];   // for kind 'bridge': 'jni' | 'protobuf' | ...; else ''
    symbols: string[];     // top referenced symbols, encoded "name:count|name:count"; '' when none
  };
  district: {
    city: string[];        // → city
    name: string[];
  };
  city: {
    name: string[];
  };
  contributor: {
    name: string[];
    emails: string[];      // comma-separated; stripped in demo snapshots
    commits: number[];
  };
}

/** Value used for a column that an `add` omits. */
export const COLUMN_DEFAULTS: { [K in EntityKind]: { [C in keyof EntityColumns[K]]: EntityColumns[K][C] extends (infer V)[] ? V : never } } = {
  file: { lang: 'other', bytes: 0, loc: 0, oid: '', unit: '' },
  unit: { primaryFile: '', fileCount: 1, loc: 0, bytes: 0, lang: 'other', importancePct: 0, fanIn: 0, fanOut: 0, district: '' },
  edge: { src: '', dst: '', kind: 'import', weight: 1, confidence: 1, mechanism: '', symbols: '' },
  district: { city: '', name: '' },
  city: { name: '' },
  contributor: { name: '', emails: '', commits: 0 },
};

/** Reference columns: column → the kind it points at, and whether '' (no target) is allowed. */
export const REFERENCE_COLUMNS: { [K in EntityKind]: Partial<Record<keyof EntityColumns[K], { kind: EntityKind; optional: boolean }>> } = {
  file: { unit: { kind: 'unit', optional: true } },
  unit: { district: { kind: 'district', optional: true } },
  edge: { src: { kind: 'unit', optional: false }, dst: { kind: 'unit', optional: false } },
  district: { city: { kind: 'city', optional: false } },
  city: {},
  contributor: {},
};

/**
 * A set of rows of one kind. `ids[i]` identifies row i; each present column has ids.length values.
 * - add:    omitted columns take COLUMN_DEFAULTS.
 * - update: only the listed columns change.
 * - remove: `cols` is empty.
 * `slots` is absent in proposals and always present in batches emitted by the store.
 */
export interface ColumnChunk<K extends EntityKind = EntityKind> {
  ids: string[];
  cols: Partial<EntityColumns[K]>;
  slots?: number[];
}

export type EntityPatch = {
  [K in EntityKind]: { op: 'add' | 'update' | 'remove'; kind: K; rows: ColumnChunk<K> };
}[EntityKind];

export type LayerKind = 'scalar' | 'categorical' | 'sparse' | 'parametric';
export type LayerStatus = 'pending' | 'partial' | 'complete';
export interface LayerDef {
  id: LayerId;
  kind: LayerKind;
  label: string;
  /** Value range used by the colour ramp. For categorical layers, [0, categories − 1]. */
  domain: [number, number];
  /** Name of a colormap known to the overlay renderer (4C). */
  colormap: string;
}
/** Overlay data, one value per unit slot. NaN means "not yet known". */
export interface Layer {
  def: LayerDef;
  status: LayerStatus;
  /** Share of units with a known value, 0..1. */
  coverage: number;
  values: Float32Array;
  /** Layer-specific side data (for example per-unit author counts for Ownership). JSON-serialisable. */
  extra?: Record<string, unknown>;
}

export type PoiKind = 'entry' | 'core' | 'boundary' | 'data' | 'risk';
export interface PoiDetail { status: 'idle' | 'loading' | 'ready' | 'error'; markdown?: string }
export interface Poi {
  type: 'poi';
  id: string;
  parent: NodeRef;
  label: string;      // ≤ 3 words
  summary: string;    // ~30 words
  kind: PoiKind;
  evidence: string;
  refs?: NodeRef[];
  details: Record<string, PoiDetail>;
}
export interface TourStep { target: NodeRef; text: string; highlights: NodeRef[] }
export interface Tour { type: 'tour'; id: string; steps: TourStep[] }
export interface Summary { type: 'summary'; id: string; parent: NodeRef; text: string; label?: string }
export type Annotation = Poi | Tour | Summary;

export interface RepoStats { files: number; units: number; edges: number; loc: number }
export interface RepoMeta {
  id: string;
  name: string;
  /** Origin remote from .git/config, without credentials; null when there is none. */
  remoteUrl: string | null;
  source: 'git' | 'folder' | 'demo' | 'import' | 'synthetic';
  headOid: string | null;
  indexChecksum: string | null;
  parserVersion: string;
  parsedAt: number;
  /** 'imports-only' while the slow pass has not been applied (PLAN.md §6.8). */
  structure: 'full' | 'imports-only';
  stats: RepoStats;
  /** How far the history walk got; absent when there is no history. */
  history?: { reachedOid: string | null; commitsWalked: number; complete: boolean };
  /** Present on demo snapshots. */
  demo?: { sourceUrl: string; commit: string; license: string };
  /** Hash of the AI digest the stored annotations were generated from. */
  digestHash?: string;
}

export type ModelPatch =
  | EntityPatch
  /** Move units between districts. `units`/`districts` (slots) are filled in by the store. */
  | { op: 'assign'; unitIds: string[]; districtIds: string[]; units?: number[]; districts?: number[] }
  /**
   * Set layer values for some units. The first patch for a layer must carry `def`.
   * `slots` (unit slots) is filled in by the store. NaN values mean "unknown".
   */
  | { op: 'layer'; id: LayerId; def?: LayerDef; unitIds: string[]; values: number[]; slots?: number[];
      status?: LayerStatus; coverage?: number; extra?: Record<string, unknown> }
  | { op: 'annotation'; action?: 'set' | 'remove'; value: Annotation }
  | { op: 'meta'; value: Partial<RepoMeta> }
  | { op: 'progress'; subsystem: Subsystem; done: number; total: number; label?: string };

/**
 * A numbered, atomic list of operations: the only way the model changes (PLAN.md §5.1).
 * A subscriber on revision r applies a batch only when batch.baseRev === r; otherwise it resyncs.
 * A `full` batch rebuilds the whole model from empty and may be applied at any revision.
 */
export interface PatchBatch {
  rev: number;
  baseRev: number;
  ops: ModelPatch[];
  full?: boolean;
}

/** Settled positions, keyed by permanent ids so they survive slot renumbering (PLAN.md §7.3). */
export interface LayoutSnapshot {
  unit: { ids: string[]; xz: number[] };          // 2 numbers per id, local to the district centre
  district: { ids: string[]; xzr: number[] };     // 3 numbers per id, local to the city centre
  city: { ids: string[]; xzr: number[] };         // 3 numbers per id, world
  /** Home positions for Reset view: same order as district.ids / city.ids, 2 numbers each. */
  home: { district: number[]; city: number[] };
}

export interface SerializedLayer {
  def: LayerDef;
  status: LayerStatus;
  coverage: number;
  /** One value per row of tables.unit, in that order; null = unknown. */
  values: (number | null)[];
  extra?: Record<string, unknown>;
}

/** The whole model as one JSON document: the snapshot, export and demo format (PLAN.md §5, §12). */
export interface RepoModel {
  schema: 1;
  meta: RepoMeta;
  /** Compacted tables: full columns, no holes, no slots. */
  tables: { [K in EntityKind]: ColumnChunk<K> };
  layers: Record<string, SerializedLayer>;
  annotations: { pois: Poi[]; tours: Tour[]; summaries: Summary[] };
  layout?: LayoutSnapshot;
}

/** The structural part of a model as produced by analysis: what the model should contain. */
export type StructureTables = { [K in Exclude<EntityKind, 'contributor'>]: ColumnChunk<K> };

// ---- id helpers ----
export const EDGE_SEP = '\t';
export function edgeId(src: string, dst: string): string { return src + EDGE_SEP + dst; }
export function fileRef(path: string): NodeRef { return `f:${path}`; }
export function unitRef(id: string): NodeRef { return `u:${id}`; }
export function districtRef(id: string): NodeRef { return `d:${id}`; }
export function cityRef(id: string): NodeRef { return `c:${id}`; }
const REF_KIND: Record<string, 'file' | 'unit' | 'district' | 'city'> = { f: 'file', u: 'unit', d: 'district', c: 'city' };
/** Split a NodeRef into its kind and id. Throws on a malformed ref. */
export function parseRef(ref: string): { kind: 'file' | 'unit' | 'district' | 'city'; id: string } {
  const kind = REF_KIND[ref[0]];
  if (!kind || ref[1] !== ':') throw new Error(`bad NodeRef: ${ref}`);
  return { kind, id: ref.slice(2) };
}
export function isNodeRef(ref: unknown): ref is NodeRef {
  return typeof ref === 'string' && ref.length > 2 && ref[1] === ':' && ref[0] in REF_KIND;
}
