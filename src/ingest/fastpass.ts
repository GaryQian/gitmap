// The fast pass over a whole manifest (PLAN.md §6.3): batch the entries by bytes, run the batches on
// the pool, and return one FileFacts per manifest entry in manifest order.
import type { Config } from '../config';
import type { ComputePool } from '../contracts/compute';
import type { Manifest, ManifestEntry, PassOptions } from '../contracts/ingest';
import type { FileFacts } from '../contracts/lang';
import { excerptKind, skippedFacts } from './facts';
import { FAST_PASS_TASK, type FastPassInput } from './fastpass.task';
import { unreadReason } from './manifest';

/**
 * Entry indices grouped into batches of about `batchBytes`: packed entries in pack-offset order, so
 * each batch is a contiguous stretch of the packfile, then working-tree entries in path order.
 */
export function makeBatches(entries: readonly ManifestEntry[], indices: readonly number[], batchBytes: number): number[][] {
  const packed: number[] = [], tree: number[] = [];
  for (const i of indices) (entries[i].read === 'pack' ? packed : tree).push(i);
  const pathOrder = (a: number, b: number) => (entries[a].path < entries[b].path ? -1 : entries[a].path > entries[b].path ? 1 : 0);
  packed.sort((a, b) => entries[a].packOffset - entries[b].packOffset || pathOrder(a, b));
  tree.sort(pathOrder);
  const batches: number[][] = [];
  for (const list of [packed, tree]) {
    let batch: number[] = [], size = 0;
    for (const i of list) {
      batch.push(i);
      size += entries[i].bytes;
      if (size >= batchBytes) { batches.push(batch); batch = []; size = 0; }
    }
    if (batch.length) batches.push(batch);
  }
  return batches;
}

/**
 * A cached fact reused for an entry. Facts are cached by blob oid, and the same blob can sit at
 * another path, so the hit only counts when the path would have produced the same facts: same
 * language and the same excerpt rule.
 */
function reuse(cached: FileFacts | undefined, entry: ManifestEntry): FileFacts | null {
  if (!cached || cached.lang !== entry.lang) return null;
  if (cached.path === entry.path) return cached;
  if (excerptKind(cached.path) !== excerptKind(entry.path)) return null;
  return { ...cached, path: entry.path };
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The fast pass was aborted.', 'AbortError');
}

let runs = 0;

export async function runFastPass(manifest: Manifest, pool: ComputePool, config: Config, opts: PassOptions = {}): Promise<FileFacts[]> {
  const { entries } = manifest;
  const { signal, cache } = opts;
  const total = entries.length;
  const out = new Array<FileFacts>(total);
  if (signal?.aborted) throw abortError(signal);

  // Files that are never opened get their facts here.
  let done = 0;
  let todo: number[] = [];
  for (let i = 0; i < total; i++) {
    if (entries[i].read === 'none') { out[i] = skippedFacts(entries[i], unreadReason(entries[i], config)); done++; } else todo.push(i);
  }

  // Read nothing that is already known (PLAN.md §6.3.1, item 3). The cache is best-effort.
  if (cache && todo.length) {
    const oids = [...new Set(todo.map((i) => entries[i].oid).filter(Boolean))];
    let known = new Map<string, FileFacts>();
    if (oids.length) { try { known = await cache.getFacts(oids); } catch { /* parse everything */ } }
    if (signal?.aborted) throw abortError(signal);
    todo = todo.filter((i) => {
      const hit = entries[i].oid ? reuse(known.get(entries[i].oid), entries[i]) : null;
      if (!hit) return true;
      out[i] = hit;
      done++;
      return false;
    });
  }
  opts.onProgress?.(done, total);

  const batches = makeBatches(entries, todo, config.parser.batchBytes);
  if (batches.length === 0) return out;

  // A group of its own, so an abort cancels this run's queued batches and nobody else's.
  const group = `${FAST_PASS_TASK}#${++runs}`;
  const lane = opts.lane ?? 'parse';
  let stopped = false;
  const work = Promise.all(batches.map(async (batch) => {
    const facts = await pool.run<FileFacts[], FastPassInput>({ type: FAST_PASS_TASK, lane, group, input: { entries: batch.map((i) => entries[i]) } });
    if (stopped) return;
    if (!Array.isArray(facts) || facts.length !== batch.length) throw new Error(`${FAST_PASS_TASK}: a batch of ${batch.length} files returned ${Array.isArray(facts) ? facts.length : 'no'} results`);
    const fresh: FileFacts[] = [];
    batch.forEach((i, k) => {
      const f = facts[k];
      // Facts with an oid were read from git and are safe to cache; the rest came from the working tree.
      if (f.oid) { if (f.skipped !== 'timeout' && f.skipped !== 'unreadable') fresh.push(f); } else f.oid = entries[i].oid;
      out[i] = f;
    });
    done += batch.length;
    opts.onProgress?.(done, total);
    if (cache && fresh.length) { try { await cache.putFacts(fresh); } catch { /* best-effort */ } }
  }));

  let onAbort: (() => void) | undefined;
  try {
    if (signal) {
      const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(abortError(signal)); signal.addEventListener('abort', onAbort, { once: true }); });
      await Promise.race([work, aborted]);
    } else await work;
  } catch (e) {
    stopped = true;
    pool.cancel(group);
    work.catch(() => {}); // the cancelled batches reject later; that is expected
    throw e;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
  return out;
}
