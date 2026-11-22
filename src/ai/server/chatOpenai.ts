// The OpenAI adapter of the chat route: the Responses API over plain `fetch`, streamed, with the
// chat tools as function tools. No SDK.
//
// What the request relies on, from the OpenAI documentation (function calling, streaming responses,
// prompt caching, reasoning):
//   - A function tool is `{ type: 'function', name, description, parameters, strict }`. The model
//     asks for one with a `function_call` output item (`call_id`, `name`, `arguments` as JSON text),
//     and the answer is a `function_call_output` input item with the same `call_id`.
//   - With `store: false` nothing is kept on the provider's side, so every request replays the
//     conversation as input items: messages, each `function_call`, and its `function_call_output`.
//   - With `stream: true` the body is server-sent events whose JSON carries a `type`. Words arrive
//     as `response.output_text.delta`. A function call is announced by `response.output_item.added`,
//     its arguments arrive as `response.function_call_arguments.delta`, and
//     `response.output_item.done` carries the finished item. The stream ends with
//     `response.completed`, `response.incomplete` (why is in `incomplete_details.reason`) or
//     `response.failed`; `error` reports a failure of the stream itself.
//   - Prompt caching is automatic and matches a prefix: tool definitions, then the opening
//     developer messages, then the conversation. The system prompt and the map overview are the
//     opening developer message, so they and the tool list are reused on every step, and the
//     conversation before the newest message is reused as it grows. Top-level `instructions` are
//     not part of that prefix on the current models, so they are not used (as in openai.ts).
//
// The model's reasoning items are not replayed: the neutral messages carry text and tool calls
// only, so each step reasons from the conversation as written. The documentation asks for the
// reasoning items to be passed back with the tool outputs so the model can continue its reasoning.
// Function calls are therefore replayed as new items, without the provider's item ids, so that they
// do not refer to reasoning items that are absent. NOT CONFIRMED against the live API: if it
// refuses such a conversation, the contract needs a field that carries the encrypted reasoning items.
import { parseToolInput, readSse } from '../chat/stream';
import { CHAT_TUNABLES } from '../chat/tunables';
import type { ChatEvent, ChatMessage, ChatStop } from '../chat/types';
import type { ChatProvider, ChatStreamRequest } from './chat';
import { AiError } from './errors';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** The API rejects a smaller `max_output_tokens`. */
const MIN_OUTPUT_TOKENS = 16;

export interface OpenAiChatOptions {
  apiKey: string;
  /** `reasoning.effort`; null leaves it out. Default `CHAT_TUNABLES.effort`. */
  reasoningEffort?: 'low' | 'medium' | 'high' | null;
  /** Replaces the HTTP transport; tests use it to stay off the network. Default: the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Default: https://api.openai.com/v1 */
  baseUrl?: string;
}

type Json = Record<string, unknown>;

function isPlain(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---- the request ----

/** The neutral conversation as Responses API input items, after the opening developer message. */
export function openAiInput(messages: readonly ChatMessage[]): Json[] {
  const items: Json[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      items.push({ role: 'user', content: [{ type: 'input_text', text: m.text }] });
    } else if (m.role === 'assistant') {
      if (m.text.trim()) items.push({ role: 'assistant', content: m.text });
      for (const call of m.toolCalls ?? []) {
        items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) });
      }
    } else {
      for (const r of m.results) {
        // There is no error flag on a function output: a failure is said in words.
        const output = r.ok ? r.content || '(no output)' : `Error: ${r.content || 'the tool failed.'}`;
        items.push({ type: 'function_call_output', call_id: r.callId, output });
      }
    }
  }
  return items;
}

export function openAiChatBody(req: ChatStreamRequest, reasoningEffort: string | null): Json {
  const opening: Json[] = [{ type: 'input_text', text: req.system }];
  if (req.context.trim()) opening.push({ type: 'input_text', text: req.context });
  return {
    model: req.model,
    // Order is what caching depends on: the constant parts first, the conversation after them.
    input: [{ role: 'developer', content: opening }, ...openAiInput(req.messages)],
    tools: req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      // The catalogue has optional arguments, which strict mode does not allow (every property
      // would have to be required). Said outright, so the API does not rewrite the schemas.
      strict: false,
    })),
    // Reasoning counts against this limit.
    max_output_tokens: Math.max(MIN_OUTPUT_TOKENS, Math.floor(req.maxOutputTokens)),
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    // File excerpts in tool results are not kept on the provider's side as stored responses.
    store: false,
    stream: true,
  };
}

// ---- failures ----

/** 429s that waiting does not fix: the account has no credit left or is over a spend or usage limit. */
const BILLING_CODES = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
]);
const RATE_LIMITED = 'The AI provider is rate limiting this server. Try again shortly.';

/** An HTTP failure as a route error, as openai.ts maps it. The provider's wording goes to the log with the key removed. */
async function httpError(res: Response, apiKey: string): Promise<AiError> {
  let detail: { type?: unknown; code?: unknown; message?: unknown } = {};
  try {
    const body: unknown = await res.json();
    if (isPlain(body) && isPlain(body.error)) detail = body.error;
  } catch { /* not JSON: a proxy's error page */ }
  const said = typeof detail.message === 'string' ? detail.message.split(apiKey).join('[key]') : '';
  console.error('[ai] provider error', res.status, detail.type, detail.code, said);

  if (res.status === 401 || res.status === 403) return new AiError('provider', 'The AI provider rejected the server credentials.');
  if (res.status === 429) {
    if (BILLING_CODES.has(String(detail.code)) || BILLING_CODES.has(String(detail.type))) {
      return new AiError('provider', 'The AI provider account has no credit left or is over its spend limit.');
    }
    const raw = res.headers.get('retry-after')?.trim();
    const retry = raw && /^\d+(\.\d+)?$/.test(raw) ? String(Math.ceil(Number(raw))) : null;
    return new AiError('rate_limited', RATE_LIMITED, retry ? { headers: { 'retry-after': retry } } : {});
  }
  if (res.status === 404) return new AiError('provider', 'The AI provider does not have the configured model.');
  if (res.status >= 400 && res.status < 500) return new AiError('provider', 'The AI provider rejected the request.');
  return new AiError('provider', 'The AI provider call failed.');
}

/** A failure reported inside the stream (`response.failed`, `error`) as an 'error' event. */
function streamFailure(error: unknown, apiKey: string): ChatEvent {
  const detail = isPlain(error) ? error : {};
  const said = typeof detail.message === 'string' ? detail.message.split(apiKey).join('[key]') : '';
  console.error('[ai] provider error in stream', detail.code, said);
  const limited = detail.code === 'rate_limit_exceeded';
  return { type: 'error', error: limited ? { code: 'rate_limited', message: RATE_LIMITED } : { code: 'provider', message: 'The AI provider call failed.' } };
}

// ---- the stream ----

interface Usage { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } | null }

function readUsage(response: Json): { inputTokens: number; outputTokens: number; cachedInputTokens?: number } {
  const u: Usage = isPlain(response.usage) ? response.usage : {};
  const cached = u.input_tokens_details?.cached_tokens;
  return {
    // `input_tokens` is the whole prompt; cache reads are a part of it, not an addition.
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}),
  };
}

/** Whether a finished response holds a refusal part (it need not have been streamed as deltas). */
function hasRefusal(response: Json): boolean {
  const output = Array.isArray(response.output) ? response.output : [];
  return output.some((item) => isPlain(item) && item.type === 'message' && Array.isArray(item.content)
    && item.content.some((part) => isPlain(part) && part.type === 'refusal'));
}

/** The Responses API stream as ChatEvents. */
async function* chatEvents(body: ReadableStream<Uint8Array>, apiKey: string): AsyncGenerator<ChatEvent, void, void> {
  /** Function calls being written, by output index. */
  const open = new Map<number, { callId: string; name: string; json: string }>();
  let calls = 0;
  let refused = false;
  let unreadable = false;

  for await (const message of readSse(body)) {
    if (message.data === '[DONE]') break;
    let event: unknown;
    try {
      event = JSON.parse(message.data);
    } catch {
      continue; // not one of the documented events
    }
    if (!isPlain(event) || typeof event.type !== 'string') continue;
    const index = typeof event.output_index === 'number' ? event.output_index : -1;
    const item = isPlain(event.item) ? event.item : null;

    switch (event.type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string' && event.delta) yield { type: 'text', delta: event.delta };
        break;
      case 'response.refusal.delta':
      case 'response.refusal.done':
        refused = true; // the stop reason carries it; the provider's refusal text is not passed on
        break;
      case 'response.output_item.added':
        if (item?.type === 'function_call') {
          open.set(index, {
            callId: typeof item.call_id === 'string' ? item.call_id : '',
            name: typeof item.name === 'string' ? item.name : '',
            json: typeof item.arguments === 'string' ? item.arguments : '',
          });
        }
        break;
      case 'response.function_call_arguments.delta': {
        const call = open.get(index);
        if (call && typeof event.delta === 'string') call.json += event.delta;
        break;
      }
      case 'response.function_call_arguments.done': {
        const call = open.get(index);
        if (call && typeof event.arguments === 'string') call.json = event.arguments;
        break;
      }
      case 'response.output_item.done': {
        if (item?.type !== 'function_call') break;
        const started = open.get(index);
        open.delete(index);
        // The finished item is the authority; what was collected covers a field it leaves out.
        const callId = typeof item.call_id === 'string' && item.call_id ? item.call_id : started?.callId ?? '';
        const name = typeof item.name === 'string' && item.name ? item.name : started?.name ?? '';
        const json = typeof item.arguments === 'string' && item.arguments ? item.arguments : started?.json ?? '';
        const input = parseToolInput(json);
        if (input && callId && name) {
          calls++;
          yield { type: 'tool_call', call: { id: callId, name, input } };
        } else {
          unreadable = true; // judged at the end: a cut-off response explains it
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = isPlain(event.response) ? event.response : {};
        let stop: ChatStop;
        if (event.type === 'response.incomplete') {
          const reason = isPlain(response.incomplete_details) ? response.incomplete_details.reason : undefined;
          if (reason === 'max_output_tokens') stop = 'max_tokens';
          else if (reason === 'content_filter') stop = 'refusal';
          else {
            console.error('[ai] provider response incomplete', reason);
            yield { type: 'error', error: { code: 'provider', message: 'The AI provider ended the answer early.' } };
            return;
          }
        } else if (refused || hasRefusal(response)) {
          stop = 'refusal';
        } else if (unreadable || open.size > 0) {
          yield { type: 'error', error: { code: 'provider', message: 'The model wrote a tool call that could not be read.' } };
          return;
        } else {
          stop = calls > 0 ? 'tool_calls' : 'end';
        }
        yield { type: 'done', stop, usage: readUsage(response) };
        return;
      }
      case 'response.failed':
        yield streamFailure(isPlain(event.response) ? event.response.error : null, apiKey);
        return;
      case 'error':
        yield streamFailure(isPlain(event.error) ? event.error : event, apiKey);
        return;
    }
  }
  yield { type: 'error', error: { code: 'provider', message: 'The AI provider ended the answer early.' } };
}

// ---- the provider ----

export function createOpenAiChat(opts: OpenAiChatOptions): ChatProvider {
  const url = `${(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/responses`;
  const reasoningEffort = opts.reasoningEffort === undefined ? CHAT_TUNABLES.effort : opts.reasoningEffort;

  return {
    id: 'openai',

    async streamChat(req: ChatStreamRequest): Promise<AsyncIterable<ChatEvent>> {
      const doFetch = opts.fetch ?? globalThis.fetch;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(openAiChatBody(req, reasoningEffort)),
          signal: req.signal,
        });
      } catch (e) {
        console.error('[ai] provider error', e instanceof Error ? e.message : e);
        throw new AiError('provider', 'Could not reach the AI provider.');
      }
      if (!res.ok) throw await httpError(res, opts.apiKey);
      if (!res.body) {
        console.error('[ai] provider error', 'no response body');
        throw new AiError('provider', 'The AI provider call failed.');
      }
      return chatEvents(res.body, opts.apiKey);
    },
  };
}
