// What can go wrong between the browser and /api/ai/*, as one small vocabulary: the server's error
// codes (contracts/ai.ts) plus the failures that never reach it. Every failure carries a plain
// sentence fit for one quiet line in the chrome.
//
// The orchestration runs in a worker and its failures are shown on the main thread, so the
// portable form is `AiErrorInfo`, a plain object that survives structured cloning. `AiClientError`
// is the same thing as a thrown Error.
import type { AiErrorBody } from '../../contracts/ai';

export type AiServerErrorCode = AiErrorBody['error']['code'];
export type AiClientErrorCode =
  | AiServerErrorCode
  /** The request never got an answer: offline, DNS, a dropped connection. */
  | 'network'
  /** The server has no /api/ai routes (a static deployment, or a dev server without them). */
  | 'unavailable'
  /** Cancelled through the AbortSignal. Not shown to the viewer. */
  | 'aborted'
  /** Anything else, including a bug on this side. */
  | 'failed';

const CODES: readonly AiClientErrorCode[] = [
  'disabled', 'no_key', 'too_large', 'rate_limited', 'refused', 'invalid', 'provider', 'network', 'unavailable', 'aborted', 'failed',
];

export interface AiErrorInfo {
  code: AiClientErrorCode;
  /** One plain sentence for the viewer. */
  message: string;
  /** With `rate_limited`, when the server said how long to wait. */
  retryAfterSeconds?: number;
}

/** The sentence shown for each code. Copy lives here so the worker and the chrome agree. */
export function describeAiError(code: AiClientErrorCode, retryAfterSeconds?: number): string {
  switch (code) {
    case 'disabled': return 'AI notes are turned off on this server.';
    case 'no_key': return 'No AI key is configured on the server.';
    case 'too_large': return 'This repository is too large to send to the AI provider.';
    case 'rate_limited': {
      const s = retryAfterSeconds === undefined ? NaN : Math.ceil(retryAfterSeconds);
      if (!(s > 0)) return 'Too many AI requests. Try again shortly.';
      return `Too many AI requests. Try again in ${s} ${s === 1 ? 'second' : 'seconds'}.`;
    }
    case 'refused': return 'The AI provider declined this request.';
    case 'invalid': return 'The server did not accept the AI request.';
    case 'provider': return 'The AI provider could not answer. Try again later.';
    case 'network': return 'Could not reach the server for AI notes.';
    case 'unavailable': return 'AI notes are not available on this server.';
    case 'aborted': return 'AI notes were cancelled.';
    case 'failed': return 'AI notes could not be written.';
  }
}

export class AiClientError extends Error implements AiErrorInfo {
  readonly code: AiClientErrorCode;
  readonly retryAfterSeconds?: number;
  /** HTTP status, when there was a response. */
  readonly status?: number;
  /** The server's own message, for the console; `message` is the sentence for the viewer. */
  readonly detail?: string;

  constructor(code: AiClientErrorCode, opts: { retryAfterSeconds?: number; status?: number; detail?: string } = {}) {
    super(describeAiError(code, opts.retryAfterSeconds));
    this.name = 'AiClientError';
    this.code = code;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }
}

export function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * Any thrown value as an `AiErrorInfo`. Reads `code` by shape, not by class, so an error that
 * crossed a worker boundary (and lost its prototype) is still understood.
 */
export function toAiErrorInfo(err: unknown): AiErrorInfo {
  if (isAbort(err)) return { code: 'aborted', message: describeAiError('aborted') };
  if (typeof err === 'object' && err !== null) {
    const { code, retryAfterSeconds } = err as { code?: unknown; retryAfterSeconds?: unknown };
    if (typeof code === 'string' && (CODES as readonly string[]).includes(code)) {
      const wait = typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined;
      // A plain object that already carries its own sentence (an outcome sent over from the coordinator,
      // such as "AI notes are written from a fresh parse…") keeps it: the code alone would say less.
      // An Error's message is not trusted for display; it is described from its code.
      const own = !(err instanceof Error) ? (err as { message?: unknown }).message : undefined;
      const message = typeof own === 'string' && own.trim() ? own : describeAiError(code as AiClientErrorCode, wait);
      const info: AiErrorInfo = { code: code as AiClientErrorCode, message };
      if (wait !== undefined) info.retryAfterSeconds = wait;
      return info;
    }
  }
  return { code: 'failed', message: describeAiError('failed') };
}
