// The wire of the chat route: a server-sent-event reader over a ReadableStream, the encoding of one
// ChatEvent, and the client that POSTs a conversation to /api/ai/chat and yields the events of the
// reply. Browser-safe, and also used by the server (it writes events with `encodeSse`, and the
// OpenAI adapter reads that provider's stream with `readSse`).
import { config } from '../../config';
import type { AiErrorBody } from '../../contracts/ai';
import { AiClientError, isAbort } from '../client/errors';
import type { AiServerErrorCode } from '../client/errors';
import { sleep } from '../client/http';
import type { ChatEvent, ChatRequest } from './types';

// ---- server-sent events ----

export interface SseMessage {
  /** The `event:` field, or 'message' when there was none. */
  event: string;
  /** The `data:` lines of the event, joined with a newline. */
  data: string;
}

/**
 * Read a text/event-stream body. Lines may end in LF, CRLF or CR and may be split anywhere between
 * chunks (inside a multi-byte character too). An event is dispatched at its blank line; comment
 * lines and events without data are skipped, and an event the stream ends in the middle of is
 * dropped, as the format says. Stopping the iteration cancels the body.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let event = '';
  let data: string[] = [];

  /** Take one line into the pending event; returns the event when the line was the blank one that ends it. */
  const take = (line: string): SseMessage | null => {
    if (line === '') {
      const done = data.length > 0 ? { event: event || 'message', data: data.join('\n') } : null;
      event = '';
      data = [];
      return done;
    }
    if (line.startsWith(':')) return null; // a comment, used as a keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    return null; // `id` and `retry` are not used
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let start = 0;
      for (;;) {
        let at = start;
        while (at < buffer.length && buffer.charCodeAt(at) !== 10 && buffer.charCodeAt(at) !== 13) at++;
        if (at === buffer.length) break;
        const cr = buffer.charCodeAt(at) === 13;
        // A CR at the very end may be the first half of a CRLF whose LF is in the next chunk.
        if (cr && at === buffer.length - 1 && !done) break;
        const message = take(buffer.slice(start, at));
        start = at + (cr && buffer.charCodeAt(at + 1) === 10 ? 2 : 1);
        if (message) yield message;
      }
      buffer = buffer.slice(start);
      if (done) return;
    }
  } finally {
    // Reached on a normal end, on an error and when the consumer stops early.
    try { await reader.cancel(); } catch { /* already closed or errored */ }
  }
}

/** One ChatEvent as it is written to the response body. JSON has no raw newlines, so one data line. */
export function encodeSse(event: ChatEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The arguments of a tool call as the providers stream them: the text of a JSON object. An empty
 * text is a call without arguments. Anything that is not a JSON object is null, never a guess.
 */
export function parseToolInput(json: string): Record<string, unknown> | null {
  if (json.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

const STOPS: readonly string[] = ['end', 'tool_calls', 'max_tokens', 'refusal'];

/** Whether a parsed value is one of the contract's events, by shape. */
export function isChatEvent(v: unknown): v is ChatEvent {
  if (!isRecord(v)) return false;
  switch (v.type) {
    case 'text': return typeof v.delta === 'string';
    case 'tool_call':
      return isRecord(v.call) && typeof v.call.id === 'string' && typeof v.call.name === 'string' && isRecord(v.call.input);
    case 'done': return typeof v.stop === 'string' && STOPS.includes(v.stop);
    case 'error': return isRecord(v.error) && typeof v.error.code === 'string' && typeof v.error.message === 'string';
    default: return false;
  }
}

// ---- the client ----

export interface ChatClient {
  /**
   * POST the conversation and yield the reply's events: any number of 'text' and 'tool_call', then
   * one 'done'. Every failure is thrown as an `AiClientError`: a non-2xx answer, an 'error' event,
   * a stream that ends without 'done' ('network'), a cancelled signal ('aborted').
   */
  stream(request: ChatRequest, opts?: { signal?: AbortSignal }): AsyncIterable<ChatEvent>;
}

export interface ChatClientOptions {
  /** Where the routes are mounted. Default '/api/ai'. */
  baseUrl?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Longest `retry-after` that is waited out for the one retry. Default `config.ai.client.maxRetryAfterSeconds`. */
  maxRetryAfterSeconds?: number;
  /** The wait before the retry; replaceable so tests do not sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const SERVER_CODES: readonly AiServerErrorCode[] = ['disabled', 'no_key', 'too_large', 'rate_limited', 'refused', 'invalid', 'provider'];

function serverCode(code: unknown): AiServerErrorCode | null {
  return typeof code === 'string' && (SERVER_CODES as readonly string[]).includes(code) ? (code as AiServerErrorCode) : null;
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

/** A non-2xx answer as the error the rest of the AI client would make of it (client/http.ts). */
async function failure(res: Response): Promise<AiClientError> {
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON: a proxy's error page, or a 404 from a static host */ }
  const error = isRecord(body) && isRecord(body.error) ? (body as unknown as AiErrorBody).error : null;
  const code = serverCode(error?.code);
  if (code) {
    return new AiClientError(code, {
      status: res.status,
      detail: typeof error?.message === 'string' ? error.message : undefined,
      retryAfterSeconds: code === 'rate_limited' ? retryAfter(res) : undefined,
    });
  }
  // No error body of ours: the route is not there, or something in between answered.
  if (res.status === 404 || res.status === 405 || res.status === 501) return new AiClientError('unavailable', { status: res.status });
  if (res.status === 429) return new AiClientError('rate_limited', { status: res.status, retryAfterSeconds: retryAfter(res) });
  if (res.status === 413) return new AiClientError('too_large', { status: res.status });
  return new AiClientError('provider', { status: res.status });
}

export function createChatClient(options: ChatClientOptions = {}): ChatClient {
  const url = `${(options.baseUrl ?? '/api/ai').replace(/\/+$/, '')}/chat`;
  const maxWait = options.maxRetryAfterSeconds ?? config.ai.client.maxRetryAfterSeconds;
  const wait = options.sleep ?? sleep;

  async function open(body: string, signal: AbortSignal | undefined): Promise<ReadableStream<Uint8Array>> {
    const doFetch = options.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body,
        signal,
      });
    } catch (err) {
      throw new AiClientError(isAbort(err) || signal?.aborted ? 'aborted' : 'network', { detail: err instanceof Error ? err.message : undefined });
    }
    if (!res.ok) throw await failure(res);
    // A 200 that is not an event stream: a static host answering every path with its index page.
    if (!res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      throw new AiClientError('unavailable', { status: res.status });
    }
    return res.body;
  }

  async function* stream(request: ChatRequest, opts?: { signal?: AbortSignal }): AsyncGenerator<ChatEvent, void, void> {
    const signal = opts?.signal;
    const body = JSON.stringify(request);
    let source: ReadableStream<Uint8Array>;
    try {
      source = await open(body, signal);
    } catch (err) {
      // The same single retry as the other routes: a rate limit that clears within a few seconds.
      const again = err instanceof AiClientError && err.code === 'rate_limited'
        && err.retryAfterSeconds !== undefined && err.retryAfterSeconds <= maxWait;
      if (!again) throw err;
      try {
        await wait(err.retryAfterSeconds! * 1000, signal);
      } catch {
        throw new AiClientError('aborted');
      }
      source = await open(body, signal);
    }

    const messages = readSse(source);
    try {
      for (;;) {
        let next: IteratorResult<SseMessage, void>;
        try {
          next = await messages.next();
        } catch (err) {
          throw new AiClientError(isAbort(err) || signal?.aborted ? 'aborted' : 'network', { detail: err instanceof Error ? err.message : undefined });
        }
        if (next.done) break;
        let event: unknown;
        try {
          event = JSON.parse(next.value.data);
        } catch {
          throw new AiClientError('provider', { detail: 'unreadable event in the chat stream' });
        }
        if (!isChatEvent(event)) continue; // an event kind this build does not know
        if (event.type === 'error') {
          throw new AiClientError(serverCode(event.error.code) ?? 'provider', { detail: event.error.message });
        }
        yield event;
        if (event.type === 'done') return;
      }
    } finally {
      // Also reached when the caller stops reading: the body is cancelled either way.
      await messages.return();
    }
    // The body ended without 'done': the connection dropped, or the Stop button cancelled it.
    throw new AiClientError(signal?.aborted ? 'aborted' : 'network', { detail: 'the chat stream ended early' });
  }

  return { stream };
}
