// Public surface of src/analysis. Package 1E owns this folder (2A adds ./cluster, 2C adds ./link).
import type { Analyze } from '../contracts/pipeline';

/** Facts in, structure out: resolve imports, form units, compute importance, cluster. Pure. */
export const analyze: Analyze = () => {
  throw new Error('not implemented: analyze (package 1E)');
};
