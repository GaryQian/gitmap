// The generation sequence (PLAN.md §11.1): map → reduce.
//
//   map     one `summaries` call per city, a few at a time. Each becomes a `Summary` annotation on
//           the city (label and text), emitted before the reduce step starts: the chrome shows it
//           when the pointer rests on the city's pill, so it should not wait for the slower calls
//   reduce  `pois` and `tour`, both given the digest, the summaries that succeeded and the digest's
//           refs; the tour is sent a moment after the points of interest so that it can be served
//           from the prompt cache the first request writes
//
// No DOM and no store: the caller hands in the replica and the facts and gets `ModelPatch`
// operations back, stage by stage through `emit` and in total in the result. It runs in the
// coordinator worker, and in Node for the demo build.
//
// Stored results are keyed by the digest hash (`RepoMeta.digestHash`). What is stored for the
// current digest is never asked for again: a complete set makes no calls at all, and a run that
// lost a stage (rate limit, network) asks only for what is missing the next time.
import type { Config } from '../../config';
import { DETAIL_QUESTIONS } from '../../contracts/ai';
import type { CitySummary, PoiItem, PoisRequest, TourRequest, TourResponse } from '../../contracts/ai';
import type { ModelReplica } from '../../contracts/store';
import { isNodeRef, parseRef } from '../../model/types';
import type {
  Annotation, ModelPatch, NodeRef, Poi, PoiDetail, PoiKind, Summary, Tour, TourFrame, TourStep, UnitRef,
} from '../../model/types';
import { hash32 } from '../../shared';
import { buildDigest, poiCount } from '../digest';
import type { DigestInput } from '../digest';
import { describeAiError, toAiErrorInfo } from './errors';
import type { AiClientErrorCode, AiErrorInfo } from './errors';
import type { AiClient } from './http';
import { CLIENT_LOCAL } from './tunables';

export type AiStage = 'summaries' | 'pois' | 'tour';

/** One thing that went wrong, and where. A city that got no summary is one entry. */
export interface AiStageError extends AiErrorInfo {
  stage: AiStage;
  /** With stage 'summaries': the city whose call failed. */
  city?: NodeRef;
}

/** Calls finished out of calls to make, for the `ai` subsystem's progress. */
export interface AiProgress { done: number; total: number }

export interface GenerateOptions {
  input: DigestInput;
  client: AiClient;
  /** Default: `input.config`. */
  config?: Config;
  signal?: AbortSignal;
  /** Called at the start, after every call, and once more with done === total when the run ends, however it ends. */
  onProgress?: (progress: AiProgress) => void;
  /**
   * Called with each stage's operations as soon as that stage completes, summaries first. Propose
   * them to the store here, or propose `ops` from the result at the end; not both.
   */
  emit?: (ops: ModelPatch[]) => void;
  /** What is stored. Default: `input.replica.meta.digestHash` and `input.replica.annotations`. */
  existing?: { digestHash?: string; annotations: readonly Annotation[] };
  /** Overrides of the client tunables, for tests and scripts. */
  timing?: { reduceHeadStartMs?: number; summaryConcurrency?: number };
}

export interface GenerateResult {
  /** Everything emitted, in order. Empty when the run was skipped or produced nothing. */
  ops: ModelPatch[];
  digestHash: string;
  /** True when everything for this digest was already stored and no request was made. */
  skipped: boolean;
  /** Every failure, in the order it happened. A run with errors may still have produced most of its results. */
  errors: AiStageError[];
  /**
   * The one failure worth a line in the chrome, or null: a failure that stopped the run, else a
   * failed points-of-interest or tour call. A city without a summary, or a cancelled run, is not one.
   */
  failure: AiErrorInfo | null;
}

// ---- ids ----

/** The id of a city's summary annotation: `summary:<cityId>`, the same for every run. */
export function summaryId(city: NodeRef): string {
  return `summary:${parseRef(city).id}`;
}

/** A point of interest's id: stable for the same file and label, so a regenerated point keeps its identity. */
export function poiId(parent: UnitRef, label: string): string {
  const key = `${parent}\n${label.trim().toLowerCase()}`;
  return `poi:${hash32(key).toString(36)}${hash32(`starmap\n${key}`).toString(36)}`;
}

/** There is one tour per map. */
export const TOUR_ID = 'tour';

/** Every detail question, not asked yet. */
export function idleDetails(): Record<string, PoiDetail> {
  return Object.fromEntries(Object.keys(DETAIL_QUESTIONS).map((q) => [q, { status: 'idle' } satisfies PoiDetail]));
}

// ---- checking what came back against the model ----

const KINDS: readonly PoiKind[] = ['entry', 'core', 'boundary', 'data', 'risk'];
const FRAMES: readonly TourFrame[] = ['file', 'district', 'city'];

function live(replica: ModelReplica, ref: unknown): ref is NodeRef {
  if (!isNodeRef(ref)) return false;
  const { kind, id } = parseRef(ref);
  return replica.table(kind).has(id);
}

/** A `u:` reference to a file that is on the map: the only thing a point of interest or a tour step may stand on. */
function liveUnit(replica: ModelReplica, ref: unknown): ref is UnitRef {
  return typeof ref === 'string' && ref.startsWith('u:') && replica.table('unit').has(ref.slice(2));
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Points of interest from a response, dropping any that does not stand on a file of this map. */
export function poisFromResponse(items: readonly PoiItem[], replica: ModelReplica): Poi[] {
  const out = new Map<string, Poi>();
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !liveUnit(replica, item.parent)) continue;
    const label = str(item.label), summary = str(item.summary);
    if (!label || !summary || !KINDS.includes(item.kind)) continue;
    const id = poiId(item.parent, label);
    if (out.has(id)) continue;
    const refs = [...new Set(list(item.refs).filter((r): r is NodeRef => live(replica, r)))];
    out.set(id, { type: 'poi', id, parent: item.parent, label, summary, kind: item.kind, evidence: str(item.evidence), refs, details: idleDetails() });
  }
  return [...out.values()];
}

/** Tour steps from a response, dropping any that does not stand on a file of this map. */
export function stepsFromResponse(steps: TourResponse['steps'], replica: ModelReplica): TourStep[] {
  const out: TourStep[] = [];
  for (const step of steps) {
    if (typeof step !== 'object' || step === null || !liveUnit(replica, step.parent)) continue;
    const text = str(step.text);
    if (!text) continue;
    const highlights = [...new Set(list(step.highlights).filter((r): r is UnitRef => liveUnit(replica, r) && r !== step.parent))];
    out.push({ parent: step.parent, frame: FRAMES.includes(step.frame) ? step.frame : 'file', text, highlights });
  }
  return out;
}

// ---- the sequence ----

/** Failures that hold for every route, so the rest of the run is not attempted. */
const STOPS: readonly AiClientErrorCode[] = ['disabled', 'no_key', 'unavailable', 'aborted'];

const set = (value: Annotation): ModelPatch => ({ op: 'annotation', action: 'set', value });
const remove = (value: Annotation): ModelPatch => ({ op: 'annotation', action: 'remove', value });

/** Run `fn` over the items, at most `limit` at a time. `fn` must not reject. */
async function inParallel<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

export async function generateAnnotations(options: GenerateOptions): Promise<GenerateResult> {
  const { client, signal } = options;
  const config = options.config ?? options.input.config;
  const input: DigestInput = config === options.input.config ? options.input : { ...options.input, config };
  const { replica } = input;

  const digest = await buildDigest(input);
  const existing = options.existing ?? { digestHash: replica.meta?.digestHash, annotations: replica.annotations };
  const same = existing.digestHash === digest.hash;
  // Annotations of another digest describe a structure that has changed: they are replaced, not reused.
  const stored = same ? existing.annotations : [];
  const stale = same ? [] : [...existing.annotations];

  const summaries = new Map<NodeRef, CitySummary>();
  for (const a of stored) if (a.type === 'summary') summaries.set(a.parent, { parent: a.parent, label: a.label ?? '', text: a.text });
  const count = poiCount(replica, config);
  const needPois = count > 0 && !stored.some((a) => a.type === 'poi');
  const needTour = replica.table('unit').count > 0 && !stored.some((a) => a.type === 'tour' && a.steps.length > 0);
  const result: GenerateResult = { ops: [], digestHash: digest.hash, skipped: false, errors: [], failure: null };
  if (!needPois && !needTour) return { ...result, skipped: true };

  const cities = digest.cities.filter((c) => !summaries.has(c.ref));
  const total = cities.length + (needPois ? 1 : 0) + (needTour ? 1 : 0);
  let done = 0;
  const step = () => { done++; options.onProgress?.({ done, total }); };

  // The first results of a new digest carry the hash and take the previous digest's annotations
  // away with them. Until something has been produced, the stored set is left as it was.
  let opened = same;
  const push = (ops: ModelPatch[]) => {
    if (ops.length === 0) return;
    const out = opened ? ops : [...stale.map(remove), { op: 'meta', value: { digestHash: digest.hash } } satisfies ModelPatch, ...ops];
    opened = true;
    result.ops.push(...out);
    options.emit?.(out);
  };

  let stopped: AiErrorInfo | null = signal?.aborted ? { code: 'aborted', message: describeAiError('aborted') } : null;
  const fail = (stage: AiStage, err: unknown, city?: NodeRef) => {
    const info = toAiErrorInfo(err);
    if (info.code === 'failed') console.warn(`starmap: AI ${stage} failed`, err);
    // one cancelled run is one entry, however many calls were in flight
    if (info.code !== 'aborted' || !result.errors.some((e) => e.code === 'aborted')) {
      result.errors.push(city ? { stage, city, ...info } : { stage, ...info });
    }
    if (!stopped && STOPS.includes(info.code)) stopped = info;
  };
  const unusable = (stage: AiStage, message: string, city?: NodeRef) => {
    result.errors.push(city ? { stage, city, code: 'invalid', message } : { stage, code: 'invalid', message });
  };

  options.onProgress?.({ done, total });
  try {
    // ---- map: one summary per city; a city whose call fails is left without one ----
    const fresh = new Map<NodeRef, Summary>();
    await inParallel(cities, options.timing?.summaryConcurrency ?? CLIENT_LOCAL.summaryConcurrency, async (city) => {
      if (stopped) return;
      try {
        const res = await client.summaries({ digestHash: digest.hash, refs: city.refs, city: city.ref, context: city.context }, { signal });
        const label = str(res.summary?.label), text = str(res.summary?.text);
        // Shown as it is when the pointer rests on the city's pill, so both halves must be there.
        if (label && text && live(replica, city.ref)) {
          summaries.set(city.ref, { parent: city.ref, label, text });
          fresh.set(city.ref, { type: 'summary', id: summaryId(city.ref), parent: city.ref, label, text });
        } else {
          unusable('summaries', 'No usable summary came back for one city.', city.ref);
        }
      } catch (err) {
        fail('summaries', err, city.ref);
      } finally {
        step();
      }
    });
    // in city order, whatever order the calls finished in
    try {
      push(digest.cities.flatMap((c) => (fresh.has(c.ref) ? [set(fresh.get(c.ref)!)] : [])));
    } catch (err) {
      fail('summaries', err); // `emit` threw (the store refused the operations): the reduce step can still run
    }

    // ---- reduce: points of interest and the tour, over byte-identical shared fields ----
    if (!stopped) {
      const shared = {
        digestHash: digest.hash,
        refs: digest.refs,
        digest: digest.digest,
        summaries: digest.cities.flatMap((c) => (summaries.has(c.ref) ? [summaries.get(c.ref)!] : [])),
      };
      const pois = async () => {
        try {
          const req: PoisRequest = { ...shared, count };
          const res = await client.pois(req, { signal });
          const found = poisFromResponse(res.pois, replica);
          if (found.length) push(found.map(set));
          else unusable('pois', 'No usable points of interest came back.');
        } catch (err) {
          fail('pois', err);
        } finally {
          step();
        }
      };
      const tour = async () => {
        try {
          const req: TourRequest = { ...shared, minSteps: config.ai.tour.minSteps, maxSteps: config.ai.tour.maxSteps };
          const res = await client.tour(req, { signal });
          const steps = stepsFromResponse(res.steps, replica);
          if (steps.length) push([set({ type: 'tour', id: TOUR_ID, steps } satisfies Tour)]);
          else unusable('tour', 'No usable tour came back.');
        } catch (err) {
          fail('tour', err);
        } finally {
          step();
        }
      };

      const poisRun = needPois ? pois() : null;
      if (poisRun && needTour) {
        // The tour waits for the head start, or for the first call to be over if that comes sooner.
        const headStart = options.timing?.reduceHeadStartMs ?? CLIENT_LOCAL.reduceHeadStartMs;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, headStart);
          void poisRun.then(() => { clearTimeout(timer); resolve(); });
        });
      }
      const tourRun = needTour && !stopped && !signal?.aborted ? tour() : null;
      await Promise.all([poisRun, tourRun]);
    }
  } finally {
    // the progress pill must go away however the run ended
    if (done < total) options.onProgress?.({ done: total, total });
  }

  const visible = (e: AiErrorInfo) => e.code !== 'aborted';
  const first = (stopped && visible(stopped) ? stopped : null)
    ?? result.errors.find((e) => e.stage !== 'summaries' && visible(e))
    ?? null;
  // every city failing the same way is worth saying even when the reduce calls then went through
  const allCitiesFailed = cities.length > 0 && result.errors.filter((e) => e.stage === 'summaries' && visible(e)).length === cities.length;
  const chosen = first ?? (allCitiesFailed ? result.errors.find((e) => e.stage === 'summaries' && visible(e))! : null);
  result.failure = chosen ? { code: chosen.code, message: chosen.message, ...(chosen.retryAfterSeconds !== undefined ? { retryAfterSeconds: chosen.retryAfterSeconds } : {}) } : null;
  return result;
}
