// AI annotations as the pipeline runs them (PLAN.md §11; the sketch is in src/ai/README.md): city
// summaries, points of interest, the tour, and the answers behind the detail buttons. The digest
// the model sees is built from the parse facts, which live beside the store, so this runs in the
// coordinator worker (and in Node scripts) and proposes its results like any other producer.
// Nothing here starts by itself, at the reveal, on a return visit or after an update: consent is the
// viewer's, kept by the page, which calls `start` (or `detail`) when it has it. `cancel` aborts every
// call in flight, and nothing more is requested until the page asks again. Lead-owned.
import { createAiClient, generateAnnotations, generateDetail, type AiClient, type AiErrorInfo } from '../ai';
import type { DetailQuestion } from '../contracts/ai';
import type { FileFacts, SyntaxFacts } from '../contracts/lang';
import { runFastPass, runSlowPass } from '../ingest';
import type { RepoModel } from '../model/types';
import type { PipelineDeps, PipelineState } from './core';

export interface AiOutcome {
  /** The one failure worth a line in the chrome, or null. A plain object: it crosses postMessage. */
  failure: AiErrorInfo | null;
}

export interface PipelineAi {
  /**
   * Generate what is missing for the map as it is now: summaries first, then points of interest and
   * the tour. Waits for the slow pass. Safe to call again: a complete stored set makes no request.
   */
  start(): Promise<AiOutcome>;
  /** Answer one detail button. `fileText` is the file as the page could read it, or null. */
  detail(poiId: string, question: DetailQuestion, fileText: string | null): Promise<AiOutcome>;
  /**
   * Abort every `start` and `detail` in flight (consent withdrawn, the map closed). What they had
   * already put on the map stays; no further request is made until the next `start` or `detail`.
   */
  cancel(): void;
}

/** Shown when a map with no folder behind it (an imported map, a demo) is asked for notes it does not have. */
const NEEDS_FOLDER: AiErrorInfo = {
  code: 'unavailable',
  message: 'AI notes are written from the files themselves. Choose the repo folder to write them for this map.',
};
const NOT_LOADED: AiErrorInfo = { code: 'unavailable', message: 'AI notes can be written once the map has finished loading.' };

const failed = (err: unknown): AiErrorInfo => ({ code: 'failed', message: `AI notes could not be written: ${String((err as Error)?.message ?? err)}` });

/**
 * `state` is read at each call: it does not exist before the reveal. `client` defaults to the
 * same-origin routes (/api/ai/*); tests and scripts pass one whose fetch calls the handlers.
 */
export function createPipelineAi(deps: PipelineDeps, state: () => PipelineState | null, client?: AiClient): PipelineAi {
  const { config, store } = deps;
  const tuning = config.ai.client;
  const http = client ?? createAiClient({ maxRetryAfterSeconds: tuning.maxRetryAfterSeconds });
  /** One controller per call in flight: `cancel` aborts them all. */
  const running = new Set<AbortController>();
  /** The generation in flight, replaced when `start` is called again. */
  let generation: AbortController | null = null;
  const begin = (): AbortController => { const c = new AbortController(); running.add(c); return c; };

  // A map shown from its saved snapshot (the usual return visit) has no parse facts in memory, and
  // the digest is written from them. When the folder is still there they are read again here, in
  // the background and through the facts cache, so it is mostly cache hits. They are kept apart from
  // state.facts on purpose: the update flow compares state.facts with the index to find what
  // changed, and facts read from today's index would make every change look already applied.
  let reread: { facts: FileFacts[]; syntax: SyntaxFacts[] } | null = null;
  let rereading: Promise<void> | null = null;
  async function factsFor(s: PipelineState, signal: AbortSignal): Promise<{ facts: FileFacts[]; syntax: SyntaxFacts[] } | null> {
    if (s.facts.length > 0) return s.syntaxComplete ? { facts: s.facts, syntax: s.syntax } : null;
    if (reread) return reread;
    const manifest = s.manifest;
    if (!manifest) return null;
    rereading ??= (async () => {
      const total = manifest.entries.length;
      const facts = await runFastPass(manifest, deps.pool, config, {
        cache: deps.cache, lane: 'otherOverlays', signal,
        onProgress: (done) => deps.emit('progress', { subsystem: 'ai', done, total: total * 2, label: 'Reading files for AI notes' }),
      });
      const syntax = await runSlowPass(manifest, deps.pool, config, {
        cache: deps.cache, lane: 'otherOverlays', signal,
        onProgress: (done, all) => deps.emit('progress', { subsystem: 'ai', done: total + Math.round((done / Math.max(1, all)) * total), total: total * 2, label: 'Reading files for AI notes' }),
      });
      if (!signal.aborted) reread = { facts, syntax };
    })().finally(() => { rereading = null; });
    await rereading;
    return reread;
  }
  const input = (got: { facts: FileFacts[]; syntax: SyntaxFacts[] }) => ({ replica: store.replica, files: got.facts, syntax: got.syntax, config });
  // The snapshot writer sees ordinary batches; it only has to be told that there is something new.
  const propose = (s: PipelineState) => (ops: Parameters<typeof store.propose>[0]) => {
    if (ops.length === 0) return;
    store.propose(ops);
    s.saver?.schedule();
  };

  return {
    async start() {
      const s = state();
      if (!s) return { failure: NOT_LOADED };
      generation?.abort();
      const mine = (generation = begin());
      try {
        // Never on a provisional structure (PLAN.md §11.1): the slow pass ends first, however long it takes.
        if (s.slowPass) await s.slowPass;
        if (mine.signal.aborted) return { failure: null }; // cancelled while waiting: nothing was asked
        // A complete stored set needs nothing: do not read a single file for it.
        const stored = Boolean(store.replica.meta?.digestHash) && store.replica.annotations.some((a) => a.type !== 'summary');
        if (s.facts.length === 0 && stored) return { failure: null };
        const got = await factsFor(s, mine.signal);
        if (mine.signal.aborted) return { failure: null };
        // No facts and no folder to read them from: a digest built without them would be a poorer
        // text, so nothing is asked.
        if (!got) return { failure: s.facts.length === 0 ? NEEDS_FOLDER : null };
        const result = await generateAnnotations({
          input: input(got),
          client: http,
          signal: mine.signal,
          timing: { summaryConcurrency: tuning.summaryConcurrency, reduceHeadStartMs: tuning.reduceHeadStartMs },
          emit: propose(s), // summaries land first, while the slower calls are still out
          onProgress: ({ done, total }) => deps.emit('progress', { subsystem: 'ai', done, total }),
        });
        return { failure: result.failure };
      } catch (err) {
        return { failure: mine.signal.aborted ? null : failed(err) };
      } finally {
        running.delete(mine);
        if (generation === mine) generation = null;
      }
    },
    async detail(poiId, question, fileText) {
      const s = state();
      if (!s) return { failure: NOT_LOADED };
      const poi = store.replica.annotations.find((a) => a.type === 'poi' && a.id === poiId);
      if (!poi || poi.type !== 'poi') return { failure: null };
      const mine = begin();
      try {
        // Neighbours' signatures come from the facts; without a folder the answer is written from the file alone.
        const got = (await factsFor(s, mine.signal)) ?? { facts: s.facts, syntax: s.syntax };
        if (mine.signal.aborted) return { failure: null };
        const result = await generateDetail({
          input: input(got), poi, question, client: http,
          signal: mine.signal,
          fileText: fileText ?? undefined, // sent in place of the skeleton when it is small enough
          emit: propose(s),                // `loading` at once, the outcome later
        });
        return { failure: result.error };
      } catch (err) {
        return { failure: mine.signal.aborted ? null : failed(err) };
      } finally {
        running.delete(mine);
      }
    },
    cancel() {
      for (const call of running) call.abort();
      running.clear();
      generation = null;
    },
  };
}

/**
 * A detail that was still being written when the map was saved will never arrive: in a stored or
 * loaded model `loading` becomes `idle`, so its button asks again instead of spinning for ever.
 * Returns the model itself when there is nothing to change, a copy otherwise.
 */
export function settleDetails(model: RepoModel): RepoModel {
  const pois = model.annotations.pois;
  if (!pois.some((p) => Object.values(p.details ?? {}).some((d) => d.status === 'loading'))) return model;
  return {
    ...model,
    annotations: {
      ...model.annotations,
      pois: pois.map((p) => ({
        ...p,
        details: Object.fromEntries(Object.entries(p.details ?? {}).map(([q, d]) => [q, d.status === 'loading' ? { status: 'idle' as const } : d])),
      })),
    },
  };
}
