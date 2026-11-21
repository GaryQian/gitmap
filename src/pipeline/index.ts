// Public surface of src/pipeline. Lead-owned (integration 1I).
import type { Config } from '../config';
import type { RepoSource, Session } from '../contracts/pipeline';
import { createBrowserSession } from './session';

/** Open a map. In the browser this starts the coordinator worker, the pool and the physics worker. */
export function createSession(source: RepoSource, config: Config): Session {
  return createBrowserSession(source, config);
}

// The pipeline itself (./core, ./node) is deliberately not re-exported here: this file is what the
// main thread imports, and parsers and analysis must stay out of the main bundle (PLAN.md §3).
