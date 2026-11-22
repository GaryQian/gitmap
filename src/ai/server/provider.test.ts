// The Anthropic adapter against a stub transport: no network, no key. This checks the request the
// adapter builds and how it reads a streamed reply, not the live API.
import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import type { Config } from '../../config';
import { AiError, createAnthropicProvider, getProvider } from './index';

function sse(events: Record<string, unknown>[]): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function reply(text: string, stopReason: string): Response {
  return sse([
    {
      type: 'message_start',
      message: {
        id: 'msg_test', type: 'message', role: 'assistant', model: 'stub', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 900, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 40 } },
    { type: 'message_stop' },
  ]);
}

function stubProvider(text: string, stopReason = 'end_turn', cfg: Config = config) {
  const sent: { url: string; headers: Headers; body: any }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return reply(text, stopReason);
  };
  return { sent, provider: createAnthropicProvider({ apiKey: 'test-key', config: cfg, fetch }) };
}

const request = {
  role: 'synthesis' as const,
  system: 'system prompt',
  cachedPrefix: 'the digest',
  prompt: 'the task',
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  maxOutputTokens: 1000,
};

describe('anthropic provider (stub transport)', () => {
  it('sends the configured model, a cached prefix block and the output schema, and reads the reply', async () => {
    const { sent, provider } = stubProvider('{"label":"Core"}');
    const res = await provider.generate<{ label: string }>(request);

    expect(res.outcome).toBe('ok');
    expect(res.value).toEqual({ label: 'Core' });
    expect(res.usage).toEqual({ inputTokens: 912, outputTokens: 40, cachedInputTokens: 900 });

    const { body } = sent[0];
    expect(body.model).toBe(config.ai.models.synthesis);
    expect(body.system).toBe(request.system);
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: request.cachedPrefix, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: request.prompt },
      ],
    }]);
    expect(body.output_config.format).toEqual({ type: 'json_schema', schema: request.schema });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    // Refusal fallback is on by default: the body field and its beta header travel together.
    expect(body.fallbacks).toBe('default');
    expect(sent[0].headers.get('anthropic-beta')).toContain('server-side-fallback');

    const plain: typeof sent = [];
    const noFallback = createAnthropicProvider({
      apiKey: 'test-key', config, refusalFallback: false,
      fetch: async (input, init) => {
        plain.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return reply('{}', 'end_turn');
      },
    });
    await noFallback.generate(request);
    expect(plain[0].body.fallbacks).toBeUndefined();
    expect(plain[0].headers.get('anthropic-beta')).toBeNull();

    const bulk = stubProvider('{}');
    await bulk.provider.generate({ ...request, role: 'bulk' });
    expect(bulk.sent[0].body.model).toBe(config.ai.models.bulk);
  });

  it('sends each tier to its own model, and the tour to the synthesis model when config has no tour entry', async () => {
    const { synthesis, tour, bulk } = config.ai.models;
    expect(new Set([synthesis, tour, bulk]).size).toBe(3); // three tiers, three models
    const sentFor = async (role: 'synthesis' | 'tour' | 'bulk', cfg: Config = config) => {
      const stub = stubProvider('{}', 'end_turn', cfg);
      await stub.provider.generate({ ...request, role });
      return stub.sent[0].body.model as string;
    };
    expect(await sentFor('synthesis')).toBe(synthesis);
    expect(await sentFor('tour')).toBe(tour);
    expect(await sentFor('bulk')).toBe(bulk);

    // a config.json written before the tour had its own tier
    const older = { ...config, ai: { ...config.ai, models: { synthesis, bulk } } } as unknown as Config;
    expect(await sentFor('tour', older)).toBe(synthesis);
    expect(await sentFor('bulk', older)).toBe(bulk);
  });

  it('reports refusals and truncation as outcomes instead of throwing', async () => {
    expect((await stubProvider('', 'refusal').provider.generate(request)).outcome).toBe('refusal');
    expect((await stubProvider('{"label":"Co', 'max_tokens').provider.generate(request)).outcome).toBe('max_tokens');
    expect((await stubProvider('not json').provider.generate(request)).outcome).toBe('invalid');
  });

  it('reports a missing key as a typed no_key error', () => {
    try {
      getProvider({}, config);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AiError);
      expect((e as AiError).code).toBe('no_key');
    }
  });
});
