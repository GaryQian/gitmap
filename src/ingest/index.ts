// Public surface of src/ingest. Package 1D owns this folder (2B adds the slow pass under ./syntax).
import type { BuildManifest, RunFastPass, RunSlowPass } from '../contracts/ingest';
import { runFastPass as fastPass } from './fastpass';
import { buildManifest as manifest } from './manifest';

export type { OpenGit } from './manifest';
export { FAST_PASS_TASK } from './fastpass.task';

/**
 * The files on the map and how each is read: from .git/index when the repo has one, otherwise from
 * a walk of the folder. Accepts a third argument, `openGit`, to inject a GitRepo in tests.
 */
export const buildManifest: typeof manifest & BuildManifest = manifest;

/** Fast pass over every manifest entry: line counts, imports, excerpts. Needs the 'ingest.fastPass' task on the pool. */
export const runFastPass: RunFastPass = fastPass;

export const runSlowPass: RunSlowPass = async () => {
  throw new Error('not implemented: runSlowPass (package 2B)');
};
