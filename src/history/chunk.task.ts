// Pool task 'history.chunk': per-path totals for a run of consecutive commits (see diff.ts).
// Consecutive commits share most of their tree objects, which the worker's object cache keeps.
import { defineTask } from '../contracts/compute';
import { chunkBuffers, runChunk } from './diff';
import { historyRepoFor, isUnavailable } from './repo';
import { HISTORY_CHUNK_TASK, type ChunkInput, type ChunkOutput } from './types';

export default defineTask<ChunkInput, ChunkOutput>({
  type: HISTORY_CHUNK_TASK,
  async run(input, ctx) {
    const repo = await historyRepoFor(ctx);
    if (isUnavailable(repo)) throw new Error(`${HISTORY_CHUNK_TASK}: ${repo.message}`);
    const out = runChunk(repo.git.odb, repo.paths, input);
    ctx.transfer(...chunkBuffers(out));
    return out;
  },
});
