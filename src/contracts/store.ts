// ModelStore and ModelReplica (PLAN.md §5.1). Implemented by src/model.
import type {
  Annotation, EntityColumns, EntityKind, Layer, LayerId, LayoutSnapshot, ModelPatch, PatchBatch, RepoMeta,
  RepoModel, StructureTables,
} from '../model/types';

export type Unsub = () => void;

/** One kind's rows, dense by slot. */
export interface ReplicaTable<K extends EntityKind = EntityKind> {
  readonly kind: K;
  /** Highest slot ever used + 1. Arrays below have at least this many entries. */
  readonly capacity: number;
  /** Number of live rows. */
  readonly count: number;
  /** Id per slot; null for an empty slot. */
  readonly ids: (string | null)[];
  /** Column values per slot. Empty slots hold COLUMN_DEFAULTS. */
  readonly cols: EntityColumns[K];
  /**
   * For each reference column, the referenced entity's slot per row (−1 when none).
   * Keys: file.unit, unit.district, edge.src, edge.dst, district.city.
   */
  readonly refSlots: Record<string, number[]>;
  /** Slot of an id, or −1. */
  slotOf(id: string): number;
  has(id: string): boolean;
  /** Live slots in ascending order. */
  slots(): number[];
}

/**
 * A copy of the model kept in step by applying batches in order. The main thread, the physics worker
 * and the coordinator each hold one. It never validates: the store already did.
 */
export interface ModelReplica {
  readonly rev: number;
  readonly meta: RepoMeta | null;
  readonly layers: ReadonlyMap<LayerId, Layer>;
  readonly annotations: readonly Annotation[];
  table<K extends EntityKind>(kind: K): ReplicaTable<K>;
  /**
   * Apply a batch. Returns false, changing nothing, when batch.baseRev !== rev and the batch is not
   * `full`: the caller must then resync with a full batch from the store.
   */
  apply(batch: PatchBatch): boolean;
  /** Called after each applied batch. */
  subscribe(fn: (batch: PatchBatch) => void): Unsub;
}

export class ProposalError extends Error {
  constructor(message: string, readonly opIndex: number) {
    super(message);
    this.name = 'ProposalError';
  }
}

/** The single writer. Validates proposals, assigns slots and revisions, and notifies subscribers. */
export interface ModelStore {
  readonly rev: number;
  /** The store's own up-to-date view. */
  readonly replica: ModelReplica;
  /**
   * Validate and apply operations as one batch. Returns the applied batch (with slots filled in).
   * Throws ProposalError, changing nothing, if any operation is invalid: duplicate id on add, unknown
   * id on update/remove, a reference that does not resolve, a column of the wrong length or type.
   * Ops are validated in order, so an op may reference entities added earlier in the same proposal.
   */
  propose(ops: ModelPatch[]): PatchBatch;
  subscribe(fn: (batch: PatchBatch) => void): Unsub;
  /** A `full` batch that reproduces the current state, slots included, for resync. */
  fullBatch(): PatchBatch;
  /** Replace everything with a saved model (one full batch through the same path). */
  load(model: RepoModel): PatchBatch;
  /** Compact and serialise. Pass the layout from PhysicsApi.getLayout() to include positions. */
  toModel(layout?: LayoutSnapshot): RepoModel;
}

/** Operations that turn the replica's current structure into `next` (adds, updates, removes, assigns). */
export type DiffStructure = (current: ModelReplica, next: StructureTables) => ModelPatch[];
