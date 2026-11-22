// Public surface of src/history (browser-safe). Package 4A owns this folder.
//
//   runHistoryWalk(pool, config, opts) → HistoryOutcome        the driver; runs in the coordinator (walk.ts)
//   'history.plan', 'history.chunk'                            pool tasks, discovered as *.task.ts
//   historyToJson / historyFromJson                            the snapshot form of a result (merge.ts)
//   parseMailmap                                               .mailmap (mailmap.ts)
//
// ---- The shapes (types.ts) ----
//
//   HistoryOutcome = { available: true, result: HistoryResult, stats }
//                  | { available: false, reason: 'no-repo' | 'no-git' | 'empty' | 'unsupported' | 'unreadable', message }
//
//   HistoryResult {
//     files: Map<path, FileHistory>      repo-relative paths; only the `paths` given to the walk, when given
//     contributors: Contributor[]        most commits first; a contributor's `id` is its index here
//     headOid                            the commit the walk started from
//     reachedOid, reachedTime            the oldest commit processed and its commit time: "history back to …"
//     commitsWalked                      commits visited, skipped merges included
//     complete                           the whole history (under `merges`) is accounted for
//     recencyComplete                    lastModified is final for every current file
//     merges                             'skip' | 'firstParent' | 'include'
//     mailmapHash                        fingerprint of the .mailmap used; consumers can ignore it
//     stoppedBy?, error?                 why `complete` is false: 'maxCommits' | 'timeBudget' | 'shallow' | …
//   }
//   FileHistory {
//     commits                            commits that touched the path
//     lastModified, firstSeen            author times, in seconds
//     authors: [contributor id, commits][]   most commits first
//     lastAuthor                         contributor id of the newest touching commit
//     lastOidPrefix                      tie-breaker used when results are merged; consumers can ignore it
//   }
//   Contributor { id, name, emails (canonical first, lower-cased), commits, lastActive (seconds) }
//
//   HistoryJson: the same facts as parallel arrays over sorted `paths`, plain JSON for snapshots.
//   historyFromJson(historyToJson(r)) gives back an equal result, usable as `opts.since`.
//
// ---- Feeding the overlay layers ----
//
// FileHistory and Contributor are structural supersets of the `FileHistory` and `HistoryContributor`
// that src/overlays defines for the layer builders, so a result (final, or a partial handed to
// onProgress) becomes their HistoryInput without copying anything:
//
//   { contributors: r.contributors, files: r.files, complete: r.complete, recencyComplete: r.recencyComplete,
//     coverage: info.totalKnown ? info.commitsWalked / info.totalKnown : info.coverage, now: Date.now() / 1000 }
//
// (`info.coverage` is the share of current files seen at least once; `totalKnown` appears once the
// planner has finished.) Contributor ids are indices into that one result: they change between
// partials, so always pass `contributors` and `files` from the same result.
//
// ---- What the facts mean ----
//
// The same as `git log --no-renames --name-only` (with --no-merges under the default
// `history.merges: "skip"`): a commit touches a path when the path's blob or mode differs from the
// commit's first parent, deletions included; renames are not followed; times are author times.
// Contributors are keyed by canonical email (after .mailmap), falling back to the name; the name
// shown is the one on the contributor's newest commit.
export { runHistoryWalk } from './walk';
export type { HistoryOutcome, HistoryProgress, HistoryWalkOptions, HistoryWalkStats } from './walk';
export { historyToJson, historyFromJson } from './merge';
export { parseMailmap, mailmapHash, type Mailmap } from './mailmap';
export {
  HISTORY_PLAN_TASK, HISTORY_CHUNK_TASK, HISTORY_GROUP,
  type FileHistory, type Contributor, type HistoryResult, type HistoryJson, type HistoryStop,
  type HistoryUnavailable, type HistoryUnavailableReason, type MergeMode,
  type PlanInput, type PlanPage, type PlanFrontier, type PlannedCommit, type ChunkInput, type ChunkOutput,
} from './types';
export { default as historyPlanTask } from './plan.task';
export { default as historyChunkTask } from './chunk.task';
