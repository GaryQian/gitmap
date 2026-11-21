// Public surface of src/pipeline. Lead-owned (integration 1I).
import type { Config } from '../config';
import type { RepoSource, Session } from '../contracts/pipeline';

/** Open a map. In the browser this starts the coordinator worker, the pool and the physics worker. */
export function createSession(_source: RepoSource, _config: Config): Session {
  throw new Error('not implemented: createSession (integration 1I)');
}
