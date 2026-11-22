// The typed client for the four /api/ai/* routes (PLAN.md §11.1). No DOM: it runs in the
// coordinator worker, on the main thread and in Node (the demo build passes its own `fetch`).
//
// A non-2xx answer becomes an `AiClientError` carrying the server's `error.code`. Nothing is retried,
// with one exception: a `rate_limited` answer whose `retry-after` is short is tried once more.
import type {
  AiErrorBody, DetailRequest, DetailResponse, PoisRequest, PoisResponse, SummariesRequest, SummariesResponse,
  TourRequest, TourResponse,
} from '../../contracts/ai';
import { AiClientError, isAbort } from './errors';
import type { AiServerErrorCode } from './errors';
import { CLIENT_LOCAL } from './tunables';

export interface CallOptions { signal?: AbortSignal }

export interface AiClient {
  summaries(req: SummariesRequest, opts?: CallOptions): Promise<SummariesResponse>;
  pois(req: PoisRequest, opts?: CallOptions): Promise<PoisResponse>;
  tour(req: TourRequest, opts?: CallOptions): Promise<TourResponse>;
  detail(req: DetailRequest, opts?: CallOptions): Promise<DetailResponse>;
}

export interface AiClientOptions {
  /** Where the routes are mounted. Default '/api/ai'. */
  baseUrl?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Longest `retry-after` that is waited out for the one retry. Default from the client tunables. */
  maxRetryAfterSeconds?: number;
  /** The wait before the retry; replaceable so tests do not sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A timer that an AbortSignal can cut short; it then rejects with an AbortError. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => new DOMException('The operation was aborted.', 'AbortError');
    if (signal?.aborted) { reject(aborted()); return; }
    const onAbort = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const SERVER_CODES: readonly AiServerErrorCode[] = ['disabled', 'no_key', 'too_large', 'rate_limited', 'refused', 'invalid', 'provider'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The `retry-after` header as seconds; the server sends whole seconds, an HTTP date is also allowed. */
function retryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

async function failure(res: Response): Promise<AiClientError> {
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON: a proxy's error page, or a 404 from a static host */ }
  const error = isRecord(body) && isRecord(body.error) ? (body as unknown as AiErrorBody).error : null;
  const detail = typeof error?.message === 'string' ? error.message : undefined;
  if (error && (SERVER_CODES as readonly string[]).includes(error.code)) {
    return new AiClientError(error.code, { status: res.status, detail, retryAfterSeconds: error.code === 'rate_limited' ? retryAfter(res) : undefined });
  }
  // No error body of ours: the routes are not there, or something in between answered.
  if (res.status === 404 || res.status === 405 || res.status === 501) return new AiClientError('unavailable', { status: res.status });
  if (res.status === 429) return new AiClientError('rate_limited', { status: res.status, retryAfterSeconds: retryAfter(res) });
  if (res.status === 413) return new AiClientError('too_large', { status: res.status });
  return new AiClientError('provider', { status: res.status });
}

export function createAiClient(options: AiClientOptions = {}): AiClient {
  const base = (options.baseUrl ?? '/api/ai').replace(/\/+$/, '');
  const maxWait = options.maxRetryAfterSeconds ?? CLIENT_LOCAL.maxRetryAfterSeconds;
  const wait = options.sleep ?? sleep;

  async function once<Res>(route: string, body: string, signal: AbortSignal | undefined, shape: (v: unknown) => v is Res): Promise<Res> {
    const doFetch = options.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      res = await doFetch(`${base}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal });
    } catch (err) {
      throw new AiClientError(isAbort(err) || signal?.aborted ? 'aborted' : 'network', { detail: err instanceof Error ? err.message : undefined });
    }
    if (!res.ok) throw await failure(res);
    let value: unknown;
    try {
      value = await res.json();
    } catch (err) {
      if (isAbort(err) || signal?.aborted) throw new AiClientError('aborted');
      // a 200 that is not JSON: a static host answering every path with its index page
      throw new AiClientError('unavailable', { status: res.status });
    }
    if (!shape(value)) throw new AiClientError('provider', { status: res.status, detail: 'unexpected response body' });
    return value;
  }

  async function post<Req, Res>(route: string, req: Req, opts: CallOptions | undefined, shape: (v: unknown) => v is Res): Promise<Res> {
    const body = JSON.stringify(req);
    try {
      return await once(route, body, opts?.signal, shape);
    } catch (err) {
      const again = err instanceof AiClientError && err.code === 'rate_limited'
        && err.retryAfterSeconds !== undefined && err.retryAfterSeconds <= maxWait;
      if (!again) throw err;
      try {
        await wait(err.retryAfterSeconds! * 1000, opts?.signal);
      } catch {
        throw new AiClientError('aborted');
      }
      return once(route, body, opts?.signal, shape);
    }
  }

  return {
    summaries: (req, opts) => post('summaries', req, opts, isSummaries),
    pois: (req, opts) => post('pois', req, opts, isPois),
    tour: (req, opts) => post('tour', req, opts, isTour),
    detail: (req, opts) => post('detail', req, opts, isDetail),
  };
}

// Only the outer shape is checked here; the orchestration validates every item against the model.
const isSummaries = (v: unknown): v is SummariesResponse => isRecord(v) && (v.summary === null || isRecord(v.summary));
const isPois = (v: unknown): v is PoisResponse => isRecord(v) && Array.isArray(v.pois);
const isTour = (v: unknown): v is TourResponse => isRecord(v) && Array.isArray(v.steps);
const isDetail = (v: unknown): v is DetailResponse => isRecord(v) && typeof v.markdown === 'string';
