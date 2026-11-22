// POST /api/ai/chat (PLAN.md §11.5): one step of the chat assistant, streamed. Like the other
// handlers it is thin and stateless. The browser sends the whole conversation, with the results of
// the tools it ran; this checks the request and its size, opens a stream at the provider, and
// passes the answer on as the contract's ChatEvents, one server-sent event each. Tools are never
// run here: a tool call is an event the page acts on.
//
// A failure before the stream starts is an ordinary JSON error body with the usual status. Once
// the stream has started, a failure is an 'error' event followed by the end of the body.
import { z } from 'zod';
import type { Config } from '../../config';
import { resolveProviderId } from '../active';
import type { AiEnv } from '../active';
import { encodeSse } from '../chat/stream';
import { CHAT_TOOLS, CHAT_TOOL_NAMES } from '../chat/tools';
import { CHAT_TUNABLES } from '../chat/tunables';
import type { ChatEvent, ChatMessage, ChatRequest, ToolDefinition } from '../chat/types';
import { estimateTokens } from '../tokens';
import { createAnthropicChat } from './chatAnthropic';
import { createOpenAiChat } from './chatOpenai';
import { CHAT_SYSTEM, contextBlock } from './chatPrompt';
import { AiError, errorResponse } from './errors';
import { LIMITS } from './handlers';
import type { Deps } from './handlers';
import { clientIp } from './limiter';

// ---- the provider interface ----

/** One step, as an adapter is asked for it. Everything a provider needs; nothing provider-specific. */
export interface ChatStreamRequest {
  /** The system prompt. Constant, so it is the first part of the cached prefix. */
  system: string;
  /** The map overview. Stable for a map: the adapter places it where its provider caches it. */
  context: string;
  messages: readonly ChatMessage[];
  tools: readonly ToolDefinition[];
  /** The provider's model id, from config. */
  model: string;
  /** Output budget of the step, thinking included. */
  maxOutputTokens: number;
  /** Aborted when the browser goes away; the adapter cancels its request. */
  signal?: AbortSignal;
}

export type ChatUsage = Extract<ChatEvent, { type: 'done' }>['usage'];

/** A model provider that can stream one chat step. Two adapters: chatAnthropic.ts and chatOpenai.ts. */
export interface ChatProvider {
  readonly id: string;
  /**
   * Open the stream. The promise settles once the provider has accepted or refused the request:
   * it rejects with an `AiError` for anything that fails before the first event (credentials, rate
   * limit, a rejected request, no connection), which the handler answers as a JSON error.
   *
   * The stream then yields text deltas as they arrive, each tool call once its arguments are
   * complete and parsed, and exactly one terminal event: 'done' with the stop reason and the usage,
   * or 'error'. It may also throw an `AiError` mid-stream; the handler turns that into an 'error' event.
   */
  streamChat(request: ChatStreamRequest): Promise<AsyncIterable<ChatEvent>>;
}

/** The handlers' dependencies plus the chat provider. `createDeps` fills both. */
export interface ChatDeps extends Deps {
  /** The chat provider, or the reason there is none (AiError 'no_key' when the key is missing). */
  chat?: ChatProvider | AiError;
  /** Called at the end of each answered step; the cached share shows whether the prompt cache is being hit. */
  onChatUsage?: (usage: NonNullable<ChatUsage>) => void;
}

/**
 * Server limits of the chat route that have no config.json entry yet. They bound the request body;
 * the per-IP rate limit is the other routes' (`LIMITS.ip`) and the input cap is `config.ai.maxInputTokens`.
 */
export const CHAT_LIMITS = {
  /** Messages in one request: user messages, assistant steps and tool-result messages together. */
  messages: 400,
  /** Characters of one user message. */
  userChars: 8_000,
  /** Characters of one assistant step's text. */
  assistantChars: 100_000,
  /** Characters of the map overview. */
  contextChars: 60_000,
  /** Tool calls in one assistant step, and results in the message that answers it. */
  callsPerStep: 16,
  /** Characters of one call's arguments, as JSON. */
  callInputChars: 8_000,
  /** Characters of one tool result: the loop's own budget with room to spare. */
  resultChars: CHAT_TUNABLES.resultChars * 2,
  /** Characters of a call id. */
  idChars: 128,
  /** Above this multiple of the input cap the raw body is rejected before it is parsed. */
  bodyRejectAbove: 3,
} as const;

// ---- the request ----

/** Both providers' ids fit this, and both accept ids of this shape when a conversation is replayed. */
const callId = z.string().min(1).max(CHAT_LIMITS.idChars).regex(/^[A-Za-z0-9_-]+$/, 'must be a tool-call id');
const toolName = z.string().refine((name) => CHAT_TOOL_NAMES.has(name), 'is not a tool of the chat assistant');

const toolCall = z.object({
  id: callId,
  name: toolName,
  input: z.record(z.string(), z.unknown())
    .refine((input) => JSON.stringify(input).length <= CHAT_LIMITS.callInputChars, 'is too large'),
});
const toolResult = z.object({
  callId,
  name: toolName,
  ok: z.boolean(),
  content: z.string().max(CHAT_LIMITS.resultChars),
});
const message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), text: z.string().min(1).max(CHAT_LIMITS.userChars) }),
  z.object({
    role: z.literal('assistant'),
    text: z.string().max(CHAT_LIMITS.assistantChars),
    toolCalls: z.array(toolCall).min(1).max(CHAT_LIMITS.callsPerStep).optional(),
  }),
  z.object({ role: z.literal('tool'), results: z.array(toolResult).min(1).max(CHAT_LIMITS.callsPerStep) }),
]);

/**
 * What is wrong with the order of a conversation, or null. The providers reject a conversation
 * whose tool calls and results do not pair up, so this is checked here, where the answer is a clear
 * 400 instead of a provider error.
 */
export function sequenceProblem(messages: readonly ChatMessage[]): { index: number; message: string } | null {
  const seen = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const prev = messages[i - 1];
    const next = messages[i + 1];
    if (i === 0 && m.role !== 'user') return { index: i, message: 'the conversation must start with a user message' };
    if (m.role === 'assistant') {
      if (!m.toolCalls) {
        if (m.text.trim() === '') return { index: i, message: 'an assistant message needs text or tool calls' };
        continue;
      }
      for (const call of m.toolCalls) {
        if (seen.has(call.id)) return { index: i, message: `tool-call id "${call.id}" is used twice` };
        seen.add(call.id);
      }
      if (next?.role !== 'tool') return { index: i, message: 'an assistant message with tool calls must be followed by their results' };
    } else if (m.role === 'tool') {
      const calls = prev?.role === 'assistant' ? prev.toolCalls : undefined;
      if (!calls) return { index: i, message: 'a tool message must follow the assistant message whose calls it answers' };
      const same = calls.length === m.results.length
        && calls.every((call, k) => call.id === m.results[k].callId && call.name === m.results[k].name);
      if (!same) return { index: i, message: 'tool results must answer the calls of the assistant message before them, in the same order' };
    }
  }
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant') return { index: messages.length - 1, message: 'the conversation must end with a user message or tool results' };
  return null;
}

export const chatRequest: z.ZodType<ChatRequest> = z
  .object({
    context: z.string().max(CHAT_LIMITS.contextChars),
    messages: z.array(message).min(1).max(CHAT_LIMITS.messages),
  })
  .superRefine((body, ctx) => {
    const problem = sequenceProblem(body.messages);
    if (problem) ctx.addIssue({ code: 'custom', message: problem.message, path: ['messages', problem.index] });
  });

// ---- provider selection ----

/**
 * The chat model of a provider: its block's `chat` id, else the `tour` id (the same tier), else
 * `synthesis`, so a config.json written before the chat tier existed still works.
 */
export function chatModel(config: Config, providerId: string): string {
  const block: { synthesis: string; tour?: string; chat?: string } = providerId === 'openai' ? config.ai.openaiModels : config.ai.models;
  return block.chat?.trim() || block.tour?.trim() || block.synthesis;
}

/** The key for one provider. Throws AiError('no_key') naming the variable when it is missing. */
function keyFrom(env: AiEnv, variable: string): string {
  const apiKey = env[variable]?.trim();
  if (!apiKey) throw new AiError('no_key', `No AI key is configured on the server (${variable}).`);
  return apiKey;
}

/**
 * The chat provider selected the way `getProvider` selects the others: `VITE_AI_PROVIDER`, then
 * `AI_PROVIDER`, then `config.ai.provider`, with the key from the same variable. Throws
 * AiError('no_key') when the key is missing and AiError('provider') for an unknown id.
 */
export function getChatProvider(env: AiEnv, config: Config): ChatProvider {
  const id = resolveProviderId(env, config);
  switch (id) {
    case 'anthropic':
      return createAnthropicChat({ apiKey: keyFrom(env, 'ANTHROPIC_API_KEY'), refusalFallback: env.AI_REFUSAL_FALLBACK !== 'off' });
    case 'openai':
      return createOpenAiChat({ apiKey: keyFrom(env, 'OPENAI_API_KEY') });
    default:
      throw new AiError('provider', `Unknown AI provider "${id}". Set VITE_AI_PROVIDER or config.json ai.provider to "anthropic" or "openai".`);
  }
}

// ---- the stream ----

const failed = (code: string, text: string): ChatEvent => ({ type: 'error', error: { code, message: text } });

/** The catalogue's spelling of a tool name; a model now and then changes only the letter case. */
function catalogueName(name: string): string | null {
  if (CHAT_TOOL_NAMES.has(name)) return name;
  const lower = name.toLowerCase();
  const matches = CHAT_TOOLS.filter((t) => t.name.toLowerCase() === lower);
  return matches.length === 1 ? matches[0].name : null;
}

/**
 * The provider's events as the route promises them: only calls to tools of the catalogue, with ids
 * the next request will accept, and exactly one terminal event whatever the adapter does. Nothing
 * a provider said is passed on in an error; its wording is in the server log.
 */
async function* checked(events: AsyncIterable<ChatEvent>, deps: ChatDeps): AsyncGenerator<ChatEvent, void, void> {
  let calls = 0;
  try {
    for await (const event of events) {
      if (event.type === 'text') {
        if (event.delta) yield event;
      } else if (event.type === 'tool_call') {
        const name = catalogueName(event.call.name);
        if (!name || !callId.safeParse(event.call.id).success || ++calls > CHAT_LIMITS.callsPerStep) {
          console.error('[ai] chat: unusable tool call', event.call.name);
          yield failed('provider', 'The model asked for a tool in a way that cannot be run.');
          return;
        }
        yield { type: 'tool_call', call: { id: event.call.id, name, input: event.call.input } };
      } else if (event.type === 'done') {
        if (event.usage) deps.onChatUsage?.(event.usage);
        // a step that says it ended in tool calls but carried none is simply over
        yield event.stop === 'tool_calls' && calls === 0 ? { ...event, stop: 'end' } : event;
        return;
      } else {
        yield event;
        return;
      }
    }
    yield failed('provider', 'The AI provider ended the answer early.');
  } catch (e) {
    if (e instanceof AiError) {
      yield failed(e.code, e.message);
    } else {
      console.error('[ai] chat stream failed', e instanceof Error ? e.message : e);
      yield failed('provider', 'The AI request failed.');
    }
  }
}

function eventStream(events: AsyncIterable<ChatEvent>, upstream: AbortController): Response {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    // Pulled, not pushed: an event is asked of the provider when the client has room for it.
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(encodeSse(next.value)));
    },
    // The browser stopped reading (the Stop button, a closed tab): stop paying for the answer.
    async cancel() {
      upstream.abort();
      await iterator.return?.();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no', // proxies that buffer by default pass events through as they come
    },
  });
}

// ---- the handler ----

function tooLarge(config: Config): AiError {
  return new AiError('too_large', `The conversation is larger than the ${config.ai.maxInputTokens}-token input limit.`);
}

/** The tool list as it is counted against the input cap: what both adapters send, give or take a key name. */
const TOOLS_TEXT = JSON.stringify(CHAT_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })));

export async function chat(request: Request, deps: ChatDeps): Promise<Response> {
  try {
    const { config } = deps;
    // The same gate, in the same order, as the other routes (handlers.ts `route`).
    if (!config.ai.enabled) throw new AiError('disabled', 'AI features are turned off on this server.');
    const provider = deps.chat ?? new AiError('provider', 'The chat assistant is not set up on this server.');
    if (provider instanceof AiError) throw provider;
    if (request.method !== 'POST') {
      throw new AiError('invalid', 'Use POST.', { status: 405, headers: { allow: 'POST' } });
    }
    const hit = await deps.limiter.hit(`ip:chat:${clientIp(request)}`, LIMITS.ip.requests, LIMITS.ip.windowMs, deps.now());
    if (!hit.allowed) {
      throw new AiError('rate_limited', 'Too many AI requests from this address. Try again shortly.',
        { headers: { 'retry-after': String(Math.ceil(hit.retryAfterMs / 1000)) } });
    }

    // Cheap size check before parsing; the check on what is actually sent follows validation.
    const raw = await request.text();
    if (estimateTokens(raw) > config.ai.maxInputTokens * CHAT_LIMITS.bodyRejectAbove) throw tooLarge(config);

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new AiError('invalid', 'The request body is not valid JSON.');
    }
    const parsed = chatRequest.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
      throw new AiError('invalid', `Invalid request: ${issues.join('; ')}`);
    }
    const body = parsed.data;

    // The input cap, by the shared estimate (it over-counts on purpose): everything the model is sent.
    const context = contextBlock(body.context);
    const sent = [CHAT_SYSTEM, context, TOOLS_TEXT, JSON.stringify(body.messages)].join('\n\n');
    if (estimateTokens(sent) > config.ai.maxInputTokens) throw tooLarge(config);

    const upstream = new AbortController();
    if (request.signal.aborted) upstream.abort();
    else request.signal.addEventListener('abort', () => upstream.abort(), { once: true });

    const events = await provider.streamChat({
      system: CHAT_SYSTEM,
      context,
      messages: body.messages,
      tools: CHAT_TOOLS,
      model: chatModel(config, provider.id),
      maxOutputTokens: CHAT_TUNABLES.maxOutputTokens,
      signal: upstream.signal,
    });
    return eventStream(checked(events, deps), upstream);
  } catch (e) {
    if (e instanceof AiError) return errorResponse(e);
    console.error('[ai] chat failed', e instanceof Error ? e.message : e);
    return errorResponse(new AiError('provider', 'The AI request failed.'));
  }
}
