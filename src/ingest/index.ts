// Public surface of src/ingest. Package 1D owns this folder (2B adds the slow pass under ./syntax).
import type { BuildManifest, RunFastPass, RunSlowPass } from '../contracts/ingest';

export const buildManifest: BuildManifest = async () => {
  throw new Error('not implemented: buildManifest (package 1D)');
};

export const runFastPass: RunFastPass = async () => {
  throw new Error('not implemented: runFastPass (package 1D)');
};

export const runSlowPass: RunSlowPass = async () => {
  throw new Error('not implemented: runSlowPass (package 2B)');
};
