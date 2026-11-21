// Public surface of src/model. Package 1A owns everything here except types.ts.
//   replica.ts  ModelReplica: applies batches; what every consumer holds
//   store.ts    ModelStore: validates proposals, assigns slots and revisions (its choices are listed at the top)
//   diff.ts     diffStructure: current structure → the structure analysis produced
//   codec.ts    the .gitmap.json.gz format

export * from './types';
export { createReplica } from './replica';

/** The single writer (PLAN.md §5.1). */
export { createModelStore } from './store';

/** Operations that turn the replica's current structure into `next`. */
export { diffStructure } from './diff';

/** Columnar JSON, gzipped: the `.gitmap.json.gz` format (PLAN.md §5, §12). decodeModel rejects an unknown schema. */
export { encodeModel, decodeModel } from './codec';
