// What happens after the reveal: work that colours and annotates the map but never moves it unless
// the user asks (PLAN.md §6.8). Lead-owned.
import { buildManifest } from '../ingest';
import { analyzeAndApply, type PipelineDeps, type PipelineState, settleCap } from './core';
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

  // Last and least urgent: what the folder holds that the map does not show (PLAN.md §6.3.1, §12).
  try {
    await checkForChanges(deps, state);
  } catch (err) {
    // The folder may have become unreadable (permission withdrawn); the map on screen is unaffected.
    // A saved map opened with its folder says nothing: the folder is a bonus there.
    if (source.kind === 'directory') {
      deps.emit('notice', { kind: 'info', message: `The folder could not be checked for edited files: ${String((err as Error)?.message ?? err)}` });
    }
  }
}

/**
 * How far the folder has moved from the map, counted and never applied: the top bar offers
 * "N files changed · Update" and nothing moves until it is clicked.
 * - By blob id: the index against what the map was built from. This is what a return visit shows
 *   (PLAN.md §12), also for a saved map that was opened together with its folder.
 * - The background working-tree check (§6.3.1): size and modified time of every tracked file against
 *   the index, then a hash of the few that differ, since a touched file is not yet a changed one.
 * The lookups are file-handle metadata calls made from this thread, a few at a time; they use no
 * pool worker, so there is no lane to queue them in, and they start only once the map is on screen.
 */
async function checkForChanges(deps: PipelineDeps, state: PipelineState): Promise<void> {
  const { config, emit } = deps;
  const { source } = state;
  if (source.kind === 'snapshot' && source.locator && !state.repo) {
    // A saved map with its folder: nothing was opened to show it, so open the folder now.
    await deps.pool.setRepo(source.locator);
    state.repo = await deps.openRepo(source.locator);
    state.manifest = await buildManifest(state.repo, config);
  } else if (source.kind !== 'directory') return;
  const { repo, manifest } = state;
  // Without an index there are no blob ids and no recorded times to compare with.
  if (!repo || !manifest || manifest.source !== 'git') return;

  const { checkWorkingTree, confirmWorkingTree, knownFiles, planUpdate } = await import('./update');
  const known = knownFiles(state, deps.store);
  let changes: Awaited<ReturnType<typeof confirmWorkingTree>> = [];
  if (config.parser.workingTreeCheck) {
    const total = manifest.entries.length;
    let last = 0;
    const flagged = await checkWorkingTree(repo, manifest, {
      onProgress(done, all) {
        const t = Date.now();
        if (t - last < 250 && done < all) return;
        last = t;
        emit('progress', { subsystem: 'workingTree', done, total: all });
      },
    });
    if (flagged.length) changes = await confirmWorkingTree(repo, flagged, config);
    emit('progress', { subsystem: 'workingTree', done: total, total });
    state.workingTree = changes;
  }
  // One number for everything an Update would do.
  const count = planUpdate(known, manifest, changes).count;
  if (count > 0 && count !== state.changedFiles) {
    state.changedFiles = count;
    emit('notice', { kind: 'files-changed', count });
  }
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
  const ms = settleCap(deps.config, deps.store.replica.table('unit').count);
  state.settle = await (deps.physics.relayout ? deps.physics.relayout(ms) : deps.physics.settle(ms));
  state.gate.refinedApplied();
  deps.emit('notice', { kind: 'cleared', which: 'refined-ready' });
  state.saver?.schedule();
}

/** Maps with an Update in flight: a second click waits for nothing and changes nothing. */
const updating = new WeakSet<PipelineState>();

/**
 * "N files changed · Update" (PLAN.md §6.8): re-parse what changed (./update), place it into the
 * structure that exists, and perform one animated re-layout. Everything arrives in one batch.
 * Rejects, with the map as it was, when the folder cannot be read or the parse fails.
 */
export async function update(deps: PipelineDeps, state: PipelineState): Promise<void> {
  if (updating.has(state)) throw new Error('An update is already running.');
  updating.add(state);
  try {
    const { applyUpdate } = await import('./update');
    // What the background check found is used when it has run; otherwise the folder is checked now,
    // so the update is based on the files as they are at the click.
    const result = await applyUpdate(deps, state, state.workingTree, {
      checkWorkingTree: state.workingTree === undefined && deps.config.parser.workingTreeCheck,
    });
    if (result.slowPassError !== undefined) {
      deps.emit('notice', { kind: 'info', message: `Call analysis did not finish for the changed files: ${result.slowPassError}` });
    }
    // Once the structure is final, an update leaves every unit where it is and places only the new
    // ones. A map still showing its provisional (imports-only) structure is clustered in full
    // instead: the update waited for the slow pass, so this is also its "Apply".
    const settled = state.structure === 'full';
    const analysis = await analyzeAndApply(deps, state, { keepIds: true, incremental: settled, extraMeta: result.meta });
    state.structure = analysis.structure;
    const ms = settleCap(deps.config, deps.store.replica.table('unit').count);
    state.settle = await (deps.physics.relayout ? deps.physics.relayout(ms) : deps.physics.settle(ms));
    if (state.gate && analysis.structure === 'full' && (state.gate.refinedReady || state.gate.mode === 'imports-only')) {
      const offered = state.gate.refinedReady;
      state.gate.refinedApplied();
      if (offered) deps.emit('notice', { kind: 'cleared', which: 'refined-ready' });
    }
    state.changedFiles = 0;
    state.workingTree = undefined;
    deps.emit('notice', { kind: 'cleared', which: 'files-changed' });
    // New commits may have come with the new files: add them to the history layers.
    if (state.manifest) state.history?.restart(state.manifest.entries.map((e) => e.path));
    state.saver?.schedule();
  } finally {
    updating.delete(state);
  }
}

/** "Load full history": walk again without the caps; the layers fill in as it goes. */
export async function loadFullHistory(_deps: PipelineDeps, state: PipelineState): Promise<void> {
  if (!state.history) throw new Error('This map has no git history to load.');
  await state.history.loadFull();
}
