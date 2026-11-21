// Public surface of src/model. Package 1A owns everything here except types.ts.
import type { DiffStructure, ModelStore } from '../contracts/store';
import type { RepoModel } from './types';

export * from './types';
export { createReplica } from './replica';

/** The single writer (PLAN.md §5.1). */
export function createModelStore(): ModelStore {
  throw new Error('not implemented: createModelStore (package 1A)');
}

/** Operations that turn the replica's current structure into `next`. */
export const diffStructure: DiffStructure = () => {
  throw new Error('not implemented: diffStructure (package 1A)');
};

/** Columnar JSON, gzipped: the `.gitmap.json.gz` format (PLAN.md §5, §12). */
export async function encodeModel(_model: RepoModel): Promise<Uint8Array> {
  throw new Error('not implemented: encodeModel (package 1A)');
}
/** Inverse of encodeModel. Rejects on an unknown schema version. */
export async function decodeModel(_bytes: Uint8Array): Promise<RepoModel> {
  throw new Error('not implemented: decodeModel (package 1A)');
}
