// The slow pass over a manifest (PLAN.md §6.3): tree-sitter definitions and references for every
// file whose plug-in has a syntax spec or an extractSymbols fallback. Batches run on the pool; the
// result holds the files that were parsed, in completion order. Unlike the fast pass, an abort is
// not an error here: the run resolves with what had finished (the reveal's 30-second escape hatch
// uses whatever call facts exist, PLAN.md §6.8).
import type { Config } from '../../config';
import type { ComputePool } from '../../contracts/compute';
import type { Manifest, ManifestEntry, PassOptions } from '../../contracts/ingest';
import type { LanguagePlugin, SyntaxFacts } from '../../contracts/lang';
import { pluginById, pluginForPath } from '../../lang';
import { makeBatches, progressWeight } from '../fastpass';
import { SLOW_PASS_TASK, type SlowPassInput } from './slowpass.task';

/**
 * Parsing costs about ten times the fast pass's scan per byte (spikes/treesitter/RESULTS.md), so
 * slow-pass batches are this much smaller than parser.batchBytes: tasks stay short enough to
 * spread over the workers, to report progress, and to stop soon after an abort.
 */
const BATCH_SHRINK = 8;

function batchBytes(config: Config): number {
  const own = (config.parser as { slowBatchBytes?: number }).slowBatchBytes;
  return own ?? Math.max(1, Math.floor(config.parser.batchBytes / BATCH_SHRINK));
}

/** The grammar a plug-in would parse a path with: a name, '' for the extractSymbols fallback, null for no slow pass. */
function grammarOf(plugin: LanguagePlugin | undefined, path: string): string | null {
  if (!plugin) return null;
  if (!plugin.syntax) return plugin.extractSymbols ? '' : null;
  try { return plugin.syntax.grammar(path); } catch { return null; }
}

/** True when the slow pass has something to do for an entry. */
export function hasSlowPass(entry: ManifestEntry, lookup: (id: string) => LanguagePlugin | undefined = pluginById): boolean {
  return entry.read !== 'none' && entry.lang !== null && grammarOf(lookup(entry.lang), entry.path) !== null;
}

/**
 * A cached fact reused for an entry. Facts are cached by blob oid and the same blob can sit at
 * another path, so a hit counts only when that path is parsed the same way.
 */
function reuse(cached: SyntaxFacts | undefined, entry: ManifestEntry): SyntaxFacts | null {
  if (!cached || cached.skipped) return null;
  if (cached.path === entry.path) return cached;
  const plugin = entry.lang ? pluginById(entry.lang) : undefined;
  if (pluginForPath(cached.path) !== plugin || grammarOf(plugin, cached.path) !== grammarOf(plugin, entry.path)) return null;
  return { ...cached, path: entry.path };
}

let runs = 0;

export async function runSlowPass(manifest: Manifest, pool: ComputePool, config: Config, opts: PassOptions<SyntaxFacts> = {}): Promise<SyntaxFacts[]> {
  const { entries } = manifest;
  const { signal, cache } = opts;
  const out: SyntaxFacts[] = [];
  if (signal?.aborted) return out;

  let todo: number[] = [];
  for (let i = 0; i < entries.length; i++) if (hasSlowPass(entries[i])) todo.push(i);
  const total = todo.length;
  let done = 0;
  // Progress by weight (see PassOptions.onProgress): parsing costs by the byte, not by the file.
  let weightTotal = 0, weightDone = 0;
  for (const i of todo) weightTotal += progressWeight(entries[i]);
  const report = () => opts.onProgress?.(done, total, weightTotal > 0 ? Math.min(1, weightDone / weightTotal) : 1);
  const weigh = (batch: readonly number[]) => { for (const i of batch) weightDone += progressWeight(entries[i]); };

  // Parse nothing that is already known (PLAN.md §6.3.1, item 6). The cache is best-effort.
  if (cache && todo.length) {
    const oids = [...new Set(todo.map((i) => entries[i].oid).filter(Boolean))];
    let known = new Map<string, SyntaxFacts>();
    if (oids.length) { try { known = await cache.getSyntax(oids); } catch { /* parse everything */ } }
    if (signal?.aborted) return out;
    const hits: SyntaxFacts[] = [];
    todo = todo.filter((i) => {
      const hit = entries[i].oid ? reuse(known.get(entries[i].oid), entries[i]) : null;
      if (hit) { hits.push(hit); weightDone += progressWeight(entries[i]); }
      return !hit;
    });
    if (hits.length) {
      out.push(...hits);
      done += hits.length;
      opts.onBatch?.(hits);
    }
  }
  report();

  const batches = makeBatches(entries, todo, batchBytes(config));
  if (batches.length === 0) return out;

  // A group of its own, so an abort cancels this run's queued batches and nobody else's.
  const group = `${SLOW_PASS_TASK}#${++runs}`;
  const lane = opts.lane ?? 'parse';
  let stopped = false;
  let failed = 0;
  let firstError: unknown;
  const work = Promise.all(batches.map(async (batch) => {
    let facts: SyntaxFacts[];
    try {
      facts = await pool.run<SyntaxFacts[], SlowPassInput>({ type: SLOW_PASS_TASK, lane, group, input: { entries: batch.map((i) => entries[i]) } });
      if (!Array.isArray(facts) || facts.length !== batch.length) throw new Error(`${SLOW_PASS_TASK}: a batch of ${batch.length} files returned ${Array.isArray(facts) ? facts.length : 'no'} results`);
    } catch (e) {
      // Call edges are an extra: a lost batch costs its files' edges, not the pass.
      if (!stopped) { failed++; firstError ??= e; done += batch.length; weigh(batch); report(); }
      return;
    }
    if (stopped) return;
    const fresh: SyntaxFacts[] = [];
    batch.forEach((i, k) => {
      const f = facts[k];
      // Facts with an oid were read from git and are safe to cache; the rest came from the working tree.
      if (f.oid) { if (!f.skipped) fresh.push(f); } else f.oid = entries[i].oid;
    });
    out.push(...facts);
    done += batch.length;
    opts.onBatch?.(facts);
    weigh(batch);
    report();
    if (cache && fresh.length) { try { await cache.putSyntax(fresh); } catch { /* best-effort */ } }
  }));

  let onAbort: (() => void) | undefined;
  try {
    if (signal) {
      const aborted = new Promise<void>((resolve) => {
        onAbort = () => {
          stopped = true; // nothing is added to `out` from here on
          pool.cancel(group); // queued batches are dropped; a running one finishes and its result is ignored
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      await Promise.race([work, aborted]);
      if (stopped) return out;
    } else await work;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
  // Every batch failing is not a parse problem (no such task on the pool, no repo): say so.
  if (failed === batches.length) throw firstError instanceof Error ? firstError : new Error(String(firstError));
  return out;
}
