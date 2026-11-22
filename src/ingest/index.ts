// Public surface of src/ingest. Package 1D owns this folder (2B adds the slow pass under ./syntax).
import type { BuildManifest, RunFastPass, RunSlowPass } from '../contracts/ingest';
import { runFastPass as fastPass } from './fastpass';
import { buildManifest as manifest } from './manifest';
import { runSlowPass as slowPass } from './syntax/slowpass';

export type { OpenGit } from './manifest';
export { FAST_PASS_TASK } from './fastpass.task';
export { SLOW_PASS_TASK } from './syntax/slowpass.task';
export { hasSlowPass } from './syntax/slowpass';

/**
 * The files on the map and how each is read: from .git/index when the repo has one, otherwise from
 * a walk of the folder. Accepts a third argument, `openGit`, to inject a GitRepo in tests.
 */
export const buildManifest: typeof manifest & BuildManifest = manifest;

/** Fast pass over every manifest entry: line counts, imports, excerpts. Needs the 'ingest.fastPass' task on the pool. */
export const runFastPass: RunFastPass = fastPass;

/**
 * Slow pass over the entries whose plug-in has a tree-sitter query or an extractSymbols fallback:
 * definitions (with signature and doc comment) and references. Needs the 'ingest.slowPass' task on
 * the pool. Results arrive in completion order; an abort resolves with what had finished.
 */
export const runSlowPass: RunSlowPass = slowPass;
