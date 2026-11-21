// What happens after the reveal: work that colours and annotates the map but never moves it unless
// the user asks (PLAN.md §6.8). Later integrations hang the slow pass, history, the working-tree
// check and snapshots off these three entry points. Lead-owned.
import type { PipelineDeps, PipelineState } from './core';

/** Started once the map is on screen. Must never reject for an optional subsystem. */
export async function afterReveal(_deps: PipelineDeps, _state: PipelineState): Promise<void> {
  // integration 2I: continue the slow pass when the escape hatch fired
  // integration 3P: write the snapshot; working-tree check
  // integration 4: history walk → layers
}

/** "Refined structure ready · Apply": recompute importance and clustering, one animated re-layout. */
export async function applyRefined(_deps: PipelineDeps, _state: PipelineState): Promise<void> {
  throw new Error('Refined structure is not available yet.');
}

/** "N files changed · Update": re-parse changed files and apply them in one animated step. */
export async function update(_deps: PipelineDeps, _state: PipelineState): Promise<void> {
  throw new Error('Update is not available yet.');
}
