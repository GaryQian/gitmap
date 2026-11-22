// The Anthropic adapter of the chat route: the official SDK, streaming, with the chat tools.
//
// What the request relies on, from the Anthropic documentation (tool use, streaming, prompt caching,
// handling stop reasons):
//   - Tools are `{ name, description, input_schema }`. The model asks for one with a `tool_use`
//     content block (`id`, `name`, `input`), and the answer is a `tool_result` block with the same
//     id in the next user message. All results of one assistant message go in one user message.
//   - A stream is `message_start`, then per content block `content_block_start`, deltas
//     (`text_delta` for words, `input_json_delta` for the pieces of a tool call's JSON arguments)
//     and `content_block_stop`, then `message_delta` with the stop reason and the output tokens.
//   - The prompt renders as tools, then system, then messages, and a cache breakpoint caches
//     everything before it. One breakpoint sits on the map overview, the last system block, so the
//     tool list, the system prompt and the overview are read from the cache on every step. The
//     top-level `cache_control` adds the automatic breakpoint that moves with the end of the
//     conversation, so each step of a tool loop reuses the steps before it.
//   - `stop_reason` is checked before anything else is believed: `refusal` and `max_tokens` can cut
//     a tool call off in the middle of its arguments.
//
// Thinking is left at the model's default (the current models reject attempts to disable it); how
// much of it there is follows `effort`. The conversation is replayed from the neutral messages, which
// carry text and tool calls only, so the model's thinking blocks are not sent back: each step
// reasons from the conversation as written.
import Anthropic from '@anthropic-ai/sdk';
import { parseToolInput } from '../chat/stream';
import { CHAT_TUNABLES } from '../chat/tunables';
import type { ChatEvent, ChatMessage, ChatStop } from '../chat/types';
import type { ChatProvider, ChatStreamRequest } from './chat';
import { AiError } from './errors';

/** Beta that enables `fallbacks: "default"`, as in provider.ts: a request the safety classifiers
 *  decline is re-run server-side on Anthropic's recommended substitute model. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicChatOptions {
  apiKey: string;
  /** Opt in to server-side refusal fallback (default true), like the other routes. */
  refusalFallback?: boolean;
  /** `output_config.effort`; null leaves it out. Default `CHAT_TUNABLES.effort`. */
  effort?: 'low' | 'medium' | 'high' | null;
  /** Replaces the HTTP transport; tests use it to stay off the network. */
  fetch?: typeof globalThis.fetch;
}

/** The neutral conversation as Messages API turns: tool calls and results become content blocks with matching ids. */
export function anthropicMessages(messages: readonly ChatMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.text }] });
    } else if (m.role === 'assistant') {
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      if (m.text.trim()) content.push({ type: 'text', text: m.text });
      for (const call of m.toolCalls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      if (content.length > 0) out.push({ role: 'assistant', content }); // an empty text block is rejected
    } else {
      out.push({
        role: 'user',
        content: m.results.map((r): Anthropic.Beta.BetaToolResultBlockParam => ({
          type: 'tool_result',
          tool_use_id: r.callId,
          // never sent empty: an error result needs words, and an empty success reads as nothing having run
          content: r.content || (r.ok ? '(no output)' : 'The tool failed.'),
          ...(r.ok ? {} : { is_error: true }),
        })),
      });
    }
  }
  return out;
}

function mapStop(reason: Anthropic.Beta.BetaStopReason | null): ChatStop {
  switch (reason) {
    case 'tool_use': return 'tool_calls';
    case 'refusal': return 'refusal';
    case 'max_tokens':
    case 'model_context_window_exceeded': return 'max_tokens';
    default: return 'end'; // end_turn, stop_sequence; pause_turn is for server tools, which are not used
  }
}

/** Map SDK errors onto the route error codes, as provider.ts does. Messages stay generic; details go to the server log. */
function toAiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.APIUserAbortError) return new AiError('provider', 'The request was cancelled.');
  if (e instanceof Anthropic.APIError) console.error('[ai] provider error', e.status, e.type, e.message);
  else console.error('[ai] provider error', e instanceof Error ? e.message : e);

  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new AiError('provider', 'The AI provider rejected the server credentials.');
  }
  if (e instanceof Anthropic.RateLimitError) {
    const retry = e.headers?.get('retry-after')?.trim();
    return new AiError('rate_limited', 'The AI provider is rate limiting this server. Try again shortly.',
      retry && /^\d+(\.\d+)?$/.test(retry) ? { headers: { 'retry-after': String(Math.ceil(Number(retry))) } } : {});
  }
  if (e instanceof Anthropic.NotFoundError) return new AiError('provider', 'The AI provider does not have the configured model.');
  if (e instanceof Anthropic.BadRequestError) return new AiError('provider', 'The AI provider rejected the request.');
  if (e instanceof Anthropic.APIConnectionError) return new AiError('provider', 'Could not reach the AI provider.');
  return new AiError('provider', 'The AI provider call failed.');
}

/** The Messages API stream as ChatEvents. */
async function* chatEvents(stream: AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent>): AsyncGenerator<ChatEvent, void, void> {
  /** Tool calls being written, by content block index. */
  const open = new Map<number, { id: string; name: string; json: string }>();
  let uncached = 0, written = 0, cached = 0, output = 0;
  let stop: Anthropic.Beta.BetaStopReason | null = null;
  let ended = false;
  let unreadable = false;

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          const u = event.message.usage;
          uncached = u.input_tokens;
          written = u.cache_creation_input_tokens ?? 0;
          cached = u.cache_read_input_tokens ?? 0;
          output = u.output_tokens;
          break;
        }
        case 'content_block_start':
          // Thinking and fallback blocks are not part of the answer; only text and tool calls are read.
          if (event.content_block.type === 'tool_use') {
            open.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
          }
          break;
        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            if (event.delta.text) yield { type: 'text', delta: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            const call = open.get(event.index);
            if (call) call.json += event.delta.partial_json;
          }
          break;
        case 'content_block_stop': {
          const call = open.get(event.index);
          if (!call) break;
          open.delete(event.index);
          const input = parseToolInput(call.json);
          if (input) yield { type: 'tool_call', call: { id: call.id, name: call.name, input } };
          else unreadable = true; // judged at the end: a cut-off step explains it
          break;
        }
        case 'message_delta':
          stop = event.delta.stop_reason ?? stop;
          // cumulative counts; the input side repeats message_start unless a fallback model took over
          output = event.usage.output_tokens ?? output;
          uncached = event.usage.input_tokens ?? uncached;
          written = event.usage.cache_creation_input_tokens ?? written;
          cached = event.usage.cache_read_input_tokens ?? cached;
          break;
        case 'message_stop':
          ended = true;
          break;
      }
    }
  } catch (e) {
    throw toAiError(e);
  }

  if (!ended && stop === null) {
    yield { type: 'error', error: { code: 'provider', message: 'The AI provider ended the answer early.' } };
    return;
  }
  const mapped = mapStop(stop);
  // A call whose arguments are not a JSON object: expected when the step was cut off or refused
  // (the stop reason says so, and the page runs no tools then); otherwise the step is unusable.
  if ((unreadable || open.size > 0) && mapped !== 'max_tokens' && mapped !== 'refusal') {
    yield { type: 'error', error: { code: 'provider', message: 'The model wrote a tool call that could not be read.' } };
    return;
  }
  yield {
    type: 'done',
    stop: mapped,
    // Total prompt size: the API reports the uncached remainder, cache writes and cache reads separately.
    usage: { inputTokens: uncached + written + cached, outputTokens: output, cachedInputTokens: cached },
  };
}

export function createAnthropicChat(opts: AnthropicChatOptions): ChatProvider {
  const client = new Anthropic({ apiKey: opts.apiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const refusalFallback = opts.refusalFallback ?? true;
  const effort = opts.effort === undefined ? CHAT_TUNABLES.effort : opts.effort;

  return {
    id: 'anthropic',

    async streamChat(req: ChatStreamRequest): Promise<AsyncIterable<ChatEvent>> {
      // tools → system → messages is the order the prompt is cached in. The breakpoint on the last
      // system block covers the tool list, the system prompt and the map overview.
      const system: Anthropic.Beta.BetaTextBlockParam[] = req.context.trim()
        ? [{ type: 'text', text: req.system }, { type: 'text', text: req.context, cache_control: { type: 'ephemeral' } }]
        : [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
      const tools: Anthropic.Beta.BetaTool[] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
        // `eager_input_streaming` is left off on purpose: the arguments are a few short strings, they
        // are not shown while they are written, and without it the API checks them before sending them.
      }));

      try {
        const stream = await client.beta.messages.create({
          model: req.model,
          max_tokens: req.maxOutputTokens,
          system,
          tools,
          messages: anthropicMessages(req.messages),
          // the automatic breakpoint: the end of the conversation, moving forward with each step
          cache_control: { type: 'ephemeral' },
          ...(effort ? { output_config: { effort } } : {}),
          ...(refusalFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
          stream: true,
        }, { signal: req.signal });
        return chatEvents(stream);
      } catch (e) {
        throw toAiError(e);
      }
    },
  };
}
