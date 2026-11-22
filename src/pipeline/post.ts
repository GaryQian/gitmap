// What happens after the reveal: work that colours and annotates the map but never moves it unless
// the user asks (PLAN.md §6.8). Later integrations hang history, the working-tree check and
// snapshots off these entry points. Lead-owned.
import { analyzeAndApply, type PipelineDeps, type PipelineState } from './core';

/** Started once the map is on screen. Must never reject for an optional subsystem. */
export async function afterReveal(_deps: PipelineDeps, _state: PipelineState): Promise<void> {
  // The slow pass, if it outlived the reveal, keeps running on its own; the gate raises
  // "Refined structure ready" when it ends.
  // integration 3P: write the snapshot; working-tree check
  // integration 4: history walk → layers
}

/**
 * "Refined structure ready · Apply": recompute links, importance and clustering from the finished
 * slow pass and perform one animated re-layout. Ids are kept where communities persist, so the
 * change stays local.
 */
export async function applyRefined(deps: PipelineDeps, state: PipelineState): Promise<void> {
  if (!state.gate?.refinedReady || !state.syntaxComplete) throw new Error('There is no refined structure to apply yet.');
  const result = await analyzeAndApply(deps, state, { keepIds: true });
  state.structure = result.structure;
  const ms = deps.config.reveal.settleMaxMs;
  state.settle = await (deps.physics.relayout ? deps.physics.relayout(ms) : deps.physics.settle(ms));
  state.gate.refinedApplied();
  deps.emit('notice', { kind: 'cleared', which: 'refined-ready' });
}

/** "N files changed · Update": re-parse changed files and apply them in one animated step. */
export async function update(_deps: PipelineDeps, _state: PipelineState): Promise<void> {
  throw new Error('Update is not available yet.');
}
