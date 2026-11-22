// The update flow as a library (work package 3M; PLAN.md §6.3.1, §6.8, §12). Browser-safe.
//
//   diffManifest(previousFiles, manifest)            what changed, by blob oid
//   knownFiles(state, store)                         the files the map shows, with the oids they were parsed from
//   checkWorkingTree(repo, indexEntries | manifest)  tracked files whose size or time on disk is not the index's
//   confirmWorkingTree(repo, paths, config)          of those, the ones whose content is not the staged blob
//   planUpdate(previous, manifest, workingTree?)     the lists and the N of "N files changed · Update"
//   applyUpdate(deps, state, workingTree?, opts?)    re-parse what changed and merge it into the state
//
// Nothing here proposes to the store or drives physics: ../post.ts does that after applyUpdate.
export { diffManifest, knownFiles } from './diff';
export { checkWorkingTree, confirmWorkingTree } from './workingTree';
export { planUpdate, applyUpdate } from './apply';
export type {
  ApplyUpdateOptions, KnownFile, ManifestDiff, UpdateLib, UpdatePlan, UpdateResult,
  WorkingTreeChange, WorkingTreeCheckOptions, WorkingTreeInput,
} from './types';
