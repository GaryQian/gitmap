// The chat route and its two adapters. No network and no key: the handler runs against a scripted
// provider, and each adapter against a fake transport that records the request and answers with a
// stream written the way that provider's documentation describes it. This checks the requests the
// adapters build and how they read a stream, not the live APIs. The environment is always passed
// in, never read, so the results do not depend on this machine's .env files.
import { describe, expect, it } from 'vitest';
import { config, withConfig } from '../../config';
import type { Config } from '../../config';
import type { AiErrorBody } from '../../contracts/ai';
import { CHAT_TOOLS } from '../chat/tools';
import type { ChatEvent, ChatMessage, ChatRequest } from '../chat/types';
import {
  AiError, CHAT_SYSTEM, anthropicMessages, chatModel, createAnthropicChat, createCannedProvider, createDeps,
  createMemoryLimiter, createOpenAiChat, handlers, openAiInput, sequenceProblem,
} from './index';
import type { ChatDeps, ChatProvider, ChatStreamRequest } from './index';

const KEY = 'test-key-not-real';

// ---- helpers ----

type Step = ChatEvent[] | AiError | ((req: ChatStreamRequest) => AsyncIterable<ChatEvent>);

/** A provider that answers each request with the next scripted step and records what it was asked. */
function scripted(...steps: Step[]): { provider: ChatProvider; requests: ChatStreamRequest[] } {
  const requests: ChatStreamRequest[] = [];
  const provider: ChatProvider = {
    id: 'anthropic',
    async streamChat(req) {
      const step = steps[requests.length];
      requests.push(req);
      if (!step) throw new Error(`scripted provider: no step for call ${requests.length}`);
      if (step instanceof AiError) throw step;
      if (typeof step === 'function') return step(req);
      return (async function* () { yield* step; })();
    },
  };
  return { provider, requests };
}

function depsFor(chat: ChatDeps['chat'], cfg: Config = config): ChatDeps {
  return { provider: createCannedProvider([]), chat, config: cfg, limiter: createMemoryLimiter(), now: () => 0 };
}

async function post(deps: ChatDeps, body: unknown): Promise<Response> {
  return handlers.chat(new Request('http://test.local/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify(body),
  }), deps);
}

async function eventsOf(res: Response): Promise<ChatEvent[]> {
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((block) => {
    expect(block.startsWith('data: ')).toBe(true);
    return JSON.parse(block.slice('data: '.length)) as ChatEvent;
  });
}

const errorOf = async (res: Response) => ((await res.json()) as AiErrorBody).error;

const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 };
const ask = (text = 'Where is the store?'): ChatRequest => ({ context: 'Repository: demo', messages: [{ role: 'user', text }] });

/** A conversation with one finished tool round trip, waiting for the model's next step. */
const roundTrip: ChatMessage[] = [
  { role: 'user', text: 'Where is the store?' },
  { role: 'assistant', text: 'Let me look.', toolCalls: [{ id: 'call_1', name: 'search_files', input: { query: 'store' } }, { id: 'call_2', name: 'get_notes', input: {} }] },
  { role: 'tool', results: [{ callId: 'call_1', name: 'search_files', ok: true, content: '[{"path":"src/app/store.ts"}]' }, { callId: 'call_2', name: 'get_notes', ok: false, content: 'No notes yet.' }] },
];

// ---- the handler ----

describe('chat handler', () => {
  it('streams text, a tool call and done as server-sent ChatEvents', async () => {
    const script: ChatEvent[] = [
      { type: 'text', delta: 'Let me ' },
      { type: 'text', delta: 'look.' },
      { type: 'tool_call', call: { id: 'call_1', name: 'search_files', input: { query: 'store' } } },
      { type: 'done', stop: 'tool_calls', usage },
    ];
    const { provider, requests } = scripted(script);
    const seen: unknown[] = [];
    const res = await post({ ...depsFor(provider), onChatUsage: (u) => seen.push(u) }, ask());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await eventsOf(res)).toEqual(script);
    expect(seen).toEqual([usage]);

    expect(requests).toHaveLength(1);
    expect(requests[0].system).toBe(CHAT_SYSTEM);
    expect(requests[0].context).toContain('Repository: demo');
    expect(requests[0].tools).toBe(CHAT_TOOLS);
    expect(requests[0].model).toBe(config.ai.models.chat);
    expect(requests[0].messages).toEqual(ask().messages);
  });

  it('accepts a conversation with a tool round trip and passes it on unchanged', async () => {
    const { provider, requests } = scripted([{ type: 'text', delta: 'It is in src/app/store.ts.' }, { type: 'done', stop: 'end' }]);
    const res = await post(depsFor(provider), { context: '', messages: roundTrip });
    expect(res.status).toBe(200);
    expect((await eventsOf(res)).at(-1)).toEqual({ type: 'done', stop: 'end' });
    expect(requests[0].messages).toEqual(roundTrip);
  });

  it('rejects a request the providers would not accept, before calling one', async () => {
    const { provider, requests } = scripted();
    const deps = depsFor(provider);
    const bad: unknown[] = [
      // a tool that is not in the catalogue
      { context: '', messages: [roundTrip[0], { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'delete_repo', input: {} }] }, { role: 'tool', results: [{ callId: 'call_1', name: 'delete_repo', ok: true, content: '' }] }] },
      // results that do not answer the calls before them
      { context: '', messages: [roundTrip[0], roundTrip[1], { role: 'tool', results: [{ callId: 'call_2', name: 'get_notes', ok: true, content: '' }] }] },
      { context: '', messages: [roundTrip[0], roundTrip[2]] },
      // calls left without results, an assistant message last, no user message first, nothing at all
      { context: '', messages: [roundTrip[0], roundTrip[1], { role: 'user', text: 'and?' }] },
      { context: '', messages: [roundTrip[0], { role: 'assistant', text: 'Hello.' }] },
      { context: '', messages: [{ role: 'assistant', text: 'Hello.' }, roundTrip[0]] },
      { context: '', messages: [] },
      { messages: [{ role: 'user', text: 'x'.repeat(100_000) }], context: '' },
    ];
    for (const body of bad) {
      const res = await post(deps, body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe('invalid');
    }
    const notJson = await handlers.chat(new Request('http://test.local/api/ai/chat', { method: 'POST', body: '{' }), deps);
    expect(notJson.status).toBe(400);
    expect((await handlers.chat(new Request('http://test.local/api/ai/chat'), deps)).status).toBe(405);
    expect(requests).toHaveLength(0);
    expect(sequenceProblem(roundTrip)).toBeNull();
  });

  it('rejects input over the token cap before the provider is called', async () => {
    const { provider, requests } = scripted();
    const small = withConfig({ ai: { maxInputTokens: 3000 } });
    const res = await post(depsFor(provider, small), { context: 'x'.repeat(20_000), messages: ask().messages });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe('too_large');
    expect(requests).toHaveLength(0);
  });

  it('applies the per-address rate limit, and the usual gates', async () => {
    const { provider, requests } = scripted();
    const limited: ChatDeps = { ...depsFor(provider), limiter: { hit: async () => ({ allowed: false, count: 99, retryAfterMs: 30_000 }) } };
    const res = await post(limited, ask());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect((await errorOf(res)).code).toBe('rate_limited');

    expect((await errorOf(await post(depsFor(provider, withConfig({ ai: { enabled: false } })), ask()))).code).toBe('disabled');
    // No key: the environment is passed in, so this machine's own settings play no part.
    const keyless = await post(createDeps({ VITE_AI_PROVIDER: 'openai' }, config), ask());
    expect(keyless.status).toBe(503);
    const noKey = await errorOf(keyless);
    expect(noKey.code).toBe('no_key');
    expect(noKey.message).toContain('OPENAI_API_KEY');
    expect((await errorOf(await post(createDeps({ VITE_AI_PROVIDER: 'anthropic' }, config), ask()))).message).toContain('ANTHROPIC_API_KEY');
    expect(requests).toHaveLength(0);
  });

  it('answers a failure before the stream with JSON, and one inside it with an error event', async () => {
    const before = scripted(new AiError('rate_limited', 'The AI provider is rate limiting this server. Try again shortly.', { headers: { 'retry-after': '7' } }));
    const res = await post(depsFor(before.provider), ask());
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('retry-after')).toBe('7');

    const during = scripted(() => (async function* (): AsyncGenerator<ChatEvent> {
      yield { type: 'text', delta: 'Half an ans' };
      throw new Error(`socket closed ${KEY}`);
    })());
    const events = await eventsOf(await post(depsFor(during.provider), ask()));
    expect(events).toEqual([{ type: 'text', delta: 'Half an ans' }, { type: 'error', error: { code: 'provider', message: 'The AI request failed.' } }]);

    // a provider stream that just stops, and one that goes on after its end
    expect((await eventsOf(await post(depsFor(scripted([{ type: 'text', delta: 'Hi' }]).provider), ask()))).at(-1)?.type).toBe('error');
    const extra = scripted([{ type: 'done', stop: 'end' }, { type: 'text', delta: 'more' }]);
    expect(await eventsOf(await post(depsFor(extra.provider), ask()))).toEqual([{ type: 'done', stop: 'end' }]);
  });

  it('passes on only calls to tools of the catalogue', async () => {
    const unknown = scripted([{ type: 'tool_call', call: { id: 'call_1', name: 'run_shell', input: {} } }, { type: 'done', stop: 'tool_calls' }]);
    const events = await eventsOf(await post(depsFor(unknown.provider), ask()));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');

    // a name that differs only in letter case is the catalogue's tool
    const cased = scripted([{ type: 'tool_call', call: { id: 'call_1', name: 'Get_Notes', input: {} } }, { type: 'done', stop: 'tool_calls' }]);
    expect((await eventsOf(await post(depsFor(cased.provider), ask())))[0]).toEqual({ type: 'tool_call', call: { id: 'call_1', name: 'get_notes', input: {} } });
  });

  it('uses the chat model of the provider, falling back to the tour and then the synthesis model', () => {
    expect(chatModel(config, 'anthropic')).toBe(config.ai.models.chat);
    expect(chatModel(config, 'openai')).toBe(config.ai.openaiModels.chat);
    const { synthesis, tour, bulk } = config.ai.models;
    const noChat = { ...config, ai: { ...config.ai, models: { synthesis, tour, bulk } } } as unknown as Config;
    expect(chatModel(noChat, 'anthropic')).toBe(tour);
    const older = { ...config, ai: { ...config.ai, models: { synthesis, bulk } } } as unknown as Config;
    expect(chatModel(older, 'anthropic')).toBe(synthesis);
  });
});

// ---- adapters ----

type Sent = { url: string; headers: Headers; body: any };

const streamRequest = (messages: ChatMessage[] = roundTrip): ChatStreamRequest => ({
  system: 'system prompt', context: 'the map overview', messages, tools: CHAT_TOOLS, model: 'model-under-test', maxOutputTokens: 4000,
});

async function drain(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function sseBody(events: Record<string, unknown>[]): Response {
  const body = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('anthropic chat adapter (stub transport)', () => {
  const start = {
    type: 'message_start',
    message: {
      id: 'msg_test', type: 'message', role: 'assistant', model: 'stub', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 12, cache_creation_input_tokens: 30, cache_read_input_tokens: 900, output_tokens: 0 },
    },
  };
  /** A reply: an (empty) thinking block, some text, then tool calls given as the pieces of their JSON arguments. */
  function reply(text: string, calls: { id: string; name: string; pieces: string[] }[], stopReason: string): Record<string, unknown>[] {
    const events: Record<string, unknown>[] = [
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 1 },
    ];
    calls.forEach((c, i) => {
      events.push({ type: 'content_block_start', index: 2 + i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
      for (const piece of c.pieces) events.push({ type: 'content_block_delta', index: 2 + i, delta: { type: 'input_json_delta', partial_json: piece } });
      events.push({ type: 'content_block_stop', index: 2 + i });
    });
    events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 40 } }, { type: 'message_stop' });
    return events;
  }
  function stub(events: Record<string, unknown>[] | Response, options: { refusalFallback?: boolean } = {}) {
    const sent: Sent[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return events instanceof Response ? events : sseBody(events);
    };
    return { sent, provider: createAnthropicChat({ apiKey: KEY, fetch, ...options }) };
  }

  it('sends tools, a cached system prefix and the conversation as content blocks with matching ids', async () => {
    const { sent, provider } = stub(reply('It is in src/app/store.ts.', [], 'end_turn'));
    await drain(await provider.streamChat(streamRequest()));

    const { body, headers } = sent[0];
    expect(body.model).toBe('model-under-test');
    expect(body.max_tokens).toBe(4000);
    expect(body.stream).toBe(true);
    expect(body.system).toEqual([
      { type: 'text', text: 'system prompt' },
      { type: 'text', text: 'the map overview', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools.map((t: any) => t.name)).toEqual(CHAT_TOOLS.map((t) => t.name));
    expect(body.tools[1]).toEqual({ name: CHAT_TOOLS[1].name, description: CHAT_TOOLS[1].description, input_schema: CHAT_TOOLS[1].inputSchema });
    expect(body.tool_choice).toBeUndefined(); // the current models reject forced tool use
    expect(body.thinking).toBeUndefined();
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Where is the store?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'call_1', name: 'search_files', input: { query: 'store' } },
          { type: 'tool_use', id: 'call_2', name: 'get_notes', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '[{"path":"src/app/store.ts"}]' },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'No notes yet.', is_error: true },
        ],
      },
    ]);
    expect(body.messages).toEqual(anthropicMessages(roundTrip));
    // Refusal fallback is on by default: the body field and its beta header travel together.
    expect(body.fallbacks).toBe('default');
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback');
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`); // the key that was passed in, nothing from the environment

    const plain = stub(reply('ok', [], 'end_turn'), { refusalFallback: false });
    await drain(await plain.provider.streamChat(streamRequest()));
    expect(plain.sent[0].body.fallbacks).toBeUndefined();
    expect(plain.sent[0].headers.get('anthropic-beta')).toBeNull();
  });

  it('reads text deltas, complete tool calls, the stop reason and the usage from the stream', async () => {
    const { provider } = stub(reply('Let me look.', [
      { id: 'toolu_1', name: 'get_file', pieces: ['{"path":', ' "src/app/store.ts"}'] },
      { id: 'toolu_2', name: 'get_view_state', pieces: [] },
    ], 'tool_use'));
    expect(await drain(await provider.streamChat(streamRequest([roundTrip[0]])))).toEqual([
      { type: 'text', delta: 'Let me look.' },
      { type: 'tool_call', call: { id: 'toolu_1', name: 'get_file', input: { path: 'src/app/store.ts' } } },
      { type: 'tool_call', call: { id: 'toolu_2', name: 'get_view_state', input: {} } },
      { type: 'done', stop: 'tool_calls', usage: { inputTokens: 942, outputTokens: 40, cachedInputTokens: 900 } },
    ]);
  });

  it('maps refusals and truncation to the stop reason, and unreadable arguments to an error', async () => {
    const last = async (events: Record<string, unknown>[]) => (await drain(await stub(events).provider.streamChat(streamRequest([roundTrip[0]])))).at(-1)!;
    expect(await last(reply('', [], 'refusal'))).toMatchObject({ type: 'done', stop: 'refusal' });
    expect(await last(reply('It is', [], 'max_tokens'))).toMatchObject({ type: 'done', stop: 'max_tokens' });
    expect(await last(reply('Done.', [], 'end_turn'))).toMatchObject({ type: 'done', stop: 'end' });
    // arguments cut off by the output limit: the stop reason explains it, and no call is passed on
    const cut = await drain(await stub(reply('', [{ id: 'toolu_1', name: 'get_file', pieces: ['{"path": "src/'] }], 'max_tokens')).provider.streamChat(streamRequest([roundTrip[0]])));
    expect(cut.map((e) => e.type)).toEqual(['done']);
    // arguments that are simply not a JSON object
    expect(await last(reply('', [{ id: 'toolu_1', name: 'get_file', pieces: ['{"path": '] }], 'tool_use'))).toMatchObject({ type: 'error', error: { code: 'provider' } });
    expect(await last(reply('', [{ id: 'toolu_1', name: 'get_file', pieces: ['["src/a.ts"]'] }], 'tool_use'))).toMatchObject({ type: 'error' });
  });

  it('reports a rejected request as a typed error without quoting the provider or the key', async () => {
    const denied = new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
    await expect(stub(denied).provider.streamChat(streamRequest())).rejects.toMatchObject({
      name: 'AiError', code: 'provider', message: 'The AI provider rejected the server credentials.',
    });
  });
});

describe('openai chat adapter (fake fetch)', () => {
  const usageBody = { input_tokens: 912, input_tokens_details: { cached_tokens: 800 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 24 }, total_tokens: 952 };
  const completed = (over: Record<string, unknown> = {}) => ({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: usageBody, ...over } });
  const call = (index: number, callId: string, name: string, pieces: string[]): Record<string, unknown>[] => [
    { type: 'response.output_item.added', output_index: index, item: { type: 'function_call', id: `fc_${index}`, call_id: callId, name, arguments: '', status: 'in_progress' } },
    ...pieces.map((delta) => ({ type: 'response.function_call_arguments.delta', item_id: `fc_${index}`, output_index: index, delta })),
    { type: 'response.function_call_arguments.done', item_id: `fc_${index}`, output_index: index, arguments: pieces.join('') },
    { type: 'response.output_item.done', output_index: index, item: { type: 'function_call', id: `fc_${index}`, call_id: callId, name, arguments: pieces.join(''), status: 'completed' } },
  ];
  const opening: Record<string, unknown>[] = [
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
  ];
  const words = (...deltas: string[]) => deltas.map((delta) => ({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta }));

  function stub(events: Record<string, unknown>[] | Response) {
    const sent: Sent[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return events instanceof Response ? events : sseBody(events);
    };
    return { sent, provider: createOpenAiChat({ apiKey: KEY, fetch }) };
  }
  const run = async (events: Record<string, unknown>[]) => drain(await stub(events).provider.streamChat(streamRequest([roundTrip[0]])));

  it('sends function tools, the constant prefix first and the conversation as input items with matching call ids', async () => {
    const { sent, provider } = stub([...opening, ...words('ok'), completed()]);
    await drain(await provider.streamChat(streamRequest()));

    const { url, headers, body } = sent[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(body.model).toBe('model-under-test');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBe(4000);
    expect(body.instructions).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
    expect(body.tools).toHaveLength(CHAT_TOOLS.length);
    expect(body.tools[1]).toEqual({ type: 'function', name: CHAT_TOOLS[1].name, description: CHAT_TOOLS[1].description, parameters: CHAT_TOOLS[1].inputSchema, strict: false });
    expect(body.input).toEqual([
      { role: 'developer', content: [{ type: 'input_text', text: 'system prompt' }, { type: 'input_text', text: 'the map overview' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Where is the store?' }] },
      { role: 'assistant', content: 'Let me look.' },
      { type: 'function_call', call_id: 'call_1', name: 'search_files', arguments: '{"query":"store"}' },
      { type: 'function_call', call_id: 'call_2', name: 'get_notes', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '[{"path":"src/app/store.ts"}]' },
      { type: 'function_call_output', call_id: 'call_2', output: 'Error: No notes yet.' },
    ]);
    expect(body.input.slice(1)).toEqual(openAiInput(roundTrip));
  });

  it('reads text deltas, complete function calls, the stop reason and the usage from the stream', async () => {
    expect(await run([
      ...opening, ...words('Let me ', 'look.'),
      ...call(2, 'call_a', 'get_file', ['{"path":', '"src/app/store.ts"}']),
      ...call(3, 'call_b', 'get_view_state', []),
      completed(),
    ])).toEqual([
      { type: 'text', delta: 'Let me ' },
      { type: 'text', delta: 'look.' },
      { type: 'tool_call', call: { id: 'call_a', name: 'get_file', input: { path: 'src/app/store.ts' } } },
      { type: 'tool_call', call: { id: 'call_b', name: 'get_view_state', input: {} } },
      { type: 'done', stop: 'tool_calls', usage: { inputTokens: 912, outputTokens: 40, cachedInputTokens: 800 } },
    ]);
    expect((await run([...opening, ...words('Done.'), completed()])).at(-1)).toMatchObject({ type: 'done', stop: 'end' });
  });

  it('maps truncation and refusals to the stop reason, and failures to an error event', async () => {
    const incomplete = (reason: string) => ({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason }, usage: usageBody } });
    expect((await run([...opening, ...words('It is'), incomplete('max_output_tokens')])).at(-1)).toMatchObject({ type: 'done', stop: 'max_tokens' });
    expect((await run([...opening, incomplete('content_filter')])).at(-1)).toMatchObject({ type: 'done', stop: 'refusal' });
    expect((await run([...opening, { type: 'response.refusal.delta', delta: 'I cannot' }, completed()])).at(-1)).toMatchObject({ type: 'done', stop: 'refusal' });
    // arguments that are not a JSON object
    expect((await run([...opening, ...call(2, 'call_a', 'get_file', ['{"path":']), completed()])).at(-1)).toMatchObject({ type: 'error', error: { code: 'provider' } });
    // a failure reported in the stream, a failure of the stream, and a stream that just stops
    const failed = (await run([...opening, { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: `boom ${KEY}` } } }])).at(-1)!;
    expect(failed).toEqual({ type: 'error', error: { code: 'provider', message: 'The AI provider call failed.' } });
    expect((await run([{ type: 'error', code: 'rate_limit_exceeded', message: 'slow down' }])).at(-1)).toMatchObject({ type: 'error', error: { code: 'rate_limited' } });
    expect((await run([...opening, ...words('Hi')])).at(-1)).toMatchObject({ type: 'error', error: { code: 'provider' } });
  });

  it('reports an HTTP failure as a typed error without quoting the provider or the key', async () => {
    const limited = new Response(JSON.stringify({ error: { type: 'requests', code: 'rate_limit_exceeded', message: `slow down ${KEY}` } }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3' },
    });
    const error = await stub(limited).provider.streamChat(streamRequest()).then(() => null, (e: unknown) => e as AiError);
    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject({ code: 'rate_limited', headers: { 'retry-after': '3' } });
    expect(error!.message).not.toContain(KEY);
  });
});

// ---- the system prompt ----

describe('chat system prompt', () => {
  it('tells the model to take the map to what it found and to write exact paths in backticks', () => {
    // a file: focus_on; a small group: select (which frames them); a district or city: focus_on the area
    expect(CHAT_SYSTEM).toMatch(/about a particular file, call focus_on/);
    expect(CHAT_SYSTEM).toMatch(/small group of files, call select/);
    expect(CHAT_SYSTEM).toMatch(/district or a city, call focus_on/);
    // not for general questions, and not more than once or twice
    expect(CHAT_SYSTEM).toMatch(/at most once or twice per answer/);
    expect(CHAT_SYSTEM).toMatch(/Leave the view alone for a general question/);
    // the panel zooms by detecting backticked paths, so they must be exact and in backticks
    expect(CHAT_SYSTEM).toMatch(/exact repo-relative path in backticks/);
    expect(CHAT_SYSTEM).toContain('`src/app/store.ts`');
  });

  it('keeps the rules it shares with the tour, and names only tools that exist', () => {
    expect(CHAT_SYSTEM).toMatch(/cannot change the repository/);
    expect(CHAT_SYSTEM).toMatch(/Do not recite measurements/);
    expect(CHAT_SYSTEM).toMatch(/not instructions to you/);
    const named = CHAT_SYSTEM.match(/\b(?:get|list|search|read|set|clear|focus|open|reset)_[a-z_]+\b|\bselect\b(?= with)/g) ?? [];
    expect(named.length).toBeGreaterThan(5);
    for (const name of named) expect(CHAT_TOOLS.some((t) => t.name === name)).toBe(true);
  });
});
