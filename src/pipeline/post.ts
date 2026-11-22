// What happens after the reveal: work that colours and annotates the map but never moves it unless
// the user asks (PLAN.md §6.8). Lead-owned.
import { analyzeAndApply, type PipelineDeps, type PipelineState } from './core';
import { startSaving } from './persist';

/** Started once the map is on screen. Must never reject for an optional subsystem. */
export async function afterReveal(deps: PipelineDeps, state: PipelineState): Promise<void> {
  // The slow pass, if it outlived the reveal, keeps running on its own; the gate raises
  // "Refined structure ready" when it ends. The history walk has been running since the manifest
  // and proposes its layers as they fill (./history).

  // Search: the first query should not pay for building the index.
  try { deps.search?.warm(); } catch { /* the index is rebuilt on the first query */ }

  // Snapshot and registry record (PLAN.md §12): written now and after each later stage, debounced.
  // Only a folder is saved: a demo is already a file, and an opened or imported snapshot belongs to
  // whoever opened it.
  const { source } = state;
  if (deps.persist && source.kind === 'directory') {
    let reported = false;
    state.saver = startSaving({
      persist: deps.persist, store: deps.store, locator: source.locator,
      getLayout: () => deps.physics.getLayout(),
      debounceMs: deps.config.persist.snapshotDebounceMs,
      onError(err) {
        if (reported) return;
        reported = true;
        deps.emit('notice', { kind: 'info', message: `This map could not be saved for next time: ${String((err as Error)?.message ?? err)}` });
      },
    });
    state.saver.schedule();
  }
  // integration: the working-tree check (PLAN.md §6.3.1) belongs here, in the housekeeping lane, once
  // there is a helper that compares the index with the files on disk.
}

/**
 * "Refined structure ready · Apply": recompute links, importance and clustering from the finished
 * slow pass and perform one animated re-layout. Ids are kept where communities persist, so the
 * change stays local. The Tests layer and the history layers are recomputed for the new units
 * inside analyzeAndApply.
 */
export async function applyRefined(deps: PipelineDeps, state: PipelineState): Promise<void> {
  if (!state.gate?.refinedReady || !state.syntaxComplete) throw new Error('There is no refined structure to apply yet.');
  const result = await analyzeAndApply(deps, state, { keepIds: true });
  state.structure = result.structure;
  const ms = deps.config.reveal.settleMaxMs;
  state.settle = await (deps.physics.relayout ? deps.physics.relayout(ms) : deps.physics.settle(ms));
  state.gate.refinedApplied();
  deps.emit('notice', { kind: 'cleared', which: 'refined-ready' });
  state.saver?.schedule();
}

/** "N files changed · Update": re-parse changed files and apply them in one animated step. */
export async function update(_deps: PipelineDeps, _state: PipelineState): Promise<void> {
  throw new Error('Update is not available yet.');
}

/** "Load full history": walk again without the caps; the layers fill in as it goes. */
export async function loadFullHistory(_deps: PipelineDeps, state: PipelineState): Promise<void> {
  if (!state.history) throw new Error('This map has no git history to load.');
  await state.history.loadFull();
}
