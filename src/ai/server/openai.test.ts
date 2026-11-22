// The OpenAI adapter against a fake `fetch`: no network, no key. This checks the request the adapter
// builds and how it reads replies and failures as the documentation describes them, not the live API.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, withConfig } from '../../config';
import type { Config } from '../../config';
import { activeAi } from '../active';
import type { AiErrorBody, PoisRequest, PoisResponse } from '../../contracts/ai';
import {
  AiError, createMemoryLimiter, createOpenAiProvider, getProvider, handlers, matchesSchema, resolveProviderId,
  strictSchemaIssues,
} from './index';
import { LENGTHS } from './prompts';
import { DETAIL_SCHEMA, REDUCE_SCHEMA, SUMMARY_SCHEMA } from './schemas';

const KEY = 'test-key-not-real';

type Sent = { url: string; headers: Headers; body: any };
type Reply = { status?: number; headers?: Record<string, string>; body: unknown };

/** A provider whose transport answers with the given replies, in order (the last one repeats). */
function stub(...replies: Reply[]) {
  return stubWith(config, ...replies);
}

function stubWith(cfg: Config, ...replies: Reply[]) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const reply = replies[Math.min(sent.length, replies.length) - 1];
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  };
  return { sent, provider: createOpenAiProvider({ apiKey: KEY, config: cfg, fetch }) };
}

const usage = { input_tokens: 912, input_tokens_details: { cached_tokens: 900 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 24 }, total_tokens: 952 };

/** A completed response: a reasoning item, then the message with the given content parts. */
function completed(content: unknown[], over: Record<string, unknown> = {}): Reply {
  return {
    body: {
      id: 'resp_test', object: 'response', status: 'completed', incomplete_details: null, error: null,
      output: [
        { type: 'reasoning', id: 'rs_test', summary: [] },
        { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content },
      ],
      usage,
      ...over,
    },
  };
}
const text = (value: unknown): Reply =>
  completed([{ type: 'output_text', text: typeof value === 'string' ? value : JSON.stringify(value), annotations: [] }]);

const schema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false };
const request = {
  role: 'synthesis' as const,
  system: 'system prompt',
  cachedPrefix: 'the digest',
  prompt: 'the task',
  schema,
  maxOutputTokens: 1000,
};

async function failure(run: () => Promise<unknown>): Promise<AiError> {
  try {
    await run();
  } catch (e) {
    expect(e).toBeInstanceOf(AiError);
    return e as AiError;
  }
  return expect.unreachable();
}

afterEach(() => { vi.restoreAllMocks(); });

describe('openai provider (fake fetch)', () => {
  it('sends the model for the role, the schema, and the cached prefix before the prompt, and reads the reply', async () => {
    const { sent, provider } = stub(text({ label: 'Core' }));
    const res = await provider.generate<{ label: string }>(request);

    expect(res).toEqual({ value: { label: 'Core' }, outcome: 'ok', usage: { inputTokens: 912, outputTokens: 40, cachedInputTokens: 900 } });

    const { url, headers, body } = sent[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(body.model).toBe(config.ai.openaiModels.synthesis);
    expect(body.max_output_tokens).toBe(request.maxOutputTokens);
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true, schema });
    // System prompt first, then the shared context with the cache breakpoint at its end, then the task.
    expect(body.input.map((m: any) => m.role)).toEqual(['developer', 'user']);
    expect(body.input[0].content[0].text).toBe(request.system);
    expect(body.input[1].content).toEqual([
      { type: 'input_text', text: request.cachedPrefix, prompt_cache_breakpoint: { mode: 'explicit' } },
      { type: 'input_text', text: request.prompt },
    ]);
    expect(body.instructions).toBeUndefined();

    // Everything before the breakpoint is byte-identical when only the prompt changes; without a
    // prefix there is one part and no caching fields.
    await provider.generate({ ...request, prompt: 'another task' });
    const upToBreakpoint = (b: any) => JSON.stringify([b.model, b.text, b.input[0], b.input[1].content[0]]);
    expect(upToBreakpoint(sent[1].body)).toBe(upToBreakpoint(body));

    const bulk = stub(text({ label: 'Core' }));
    await bulk.provider.generate({ ...request, role: 'bulk', cachedPrefix: undefined });
    expect(bulk.sent[0].body.model).toBe(config.ai.openaiModels.bulk);
    expect(bulk.sent[0].body.input[1].content).toEqual([{ type: 'input_text', text: request.prompt }]);
    expect(bulk.sent[0].body.prompt_cache_options).toBeUndefined();
  });

  it('sends each tier to its own model, and the tour to the synthesis model when config has no tour entry', async () => {
    const { synthesis, tour, bulk } = config.ai.openaiModels;
    expect(new Set([synthesis, tour, bulk]).size).toBe(3); // three tiers, three models
    const sentFor = async (role: 'synthesis' | 'tour' | 'bulk', cfg: Config = config) => {
      const s = stubWith(cfg, text({ label: 'Core' }));
      await s.provider.generate({ ...request, role });
      return s.sent[0].body.model as string;
    };
    expect(await sentFor('synthesis')).toBe(synthesis);
    expect(await sentFor('tour')).toBe(tour);
    expect(await sentFor('bulk')).toBe(bulk);

    // a config.json written before the tour had its own tier
    const older = { ...config, ai: { ...config.ai, openaiModels: { synthesis, bulk } } } as unknown as Config;
    expect(await sentFor('tour', older)).toBe(synthesis);
    expect(await sentFor('bulk', older)).toBe(bulk);
  });

  it('reports refusals, truncation and unusable output as outcomes instead of throwing', async () => {
    const refused = stub(completed([{ type: 'refusal', refusal: 'I cannot help with that.' }]));
    expect(await refused.provider.generate(request)).toMatchObject({ value: null, outcome: 'refusal' });

    const cutOff = stub(completed([{ type: 'output_text', text: '{"label":"Co', annotations: [] }], {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    }));
    const truncated = await cutOff.provider.generate(request);
    expect(truncated).toMatchObject({ value: null, outcome: 'max_tokens' });
    expect(truncated.usage.outputTokens).toBe(40);

    // Out of room while still reasoning: no message item at all.
    const noMessage = stub({ body: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', summary: [] }], usage } });
    expect((await noMessage.provider.generate(request)).outcome).toBe('max_tokens');

    expect((await stub(text('not json')).provider.generate(request)).outcome).toBe('invalid');
    expect((await stub(text({ label: 7 })).provider.generate(request)).outcome).toBe('invalid');
    expect((await stub(text({ name: 'Core' })).provider.generate(request)).outcome).toBe('invalid');
  });

  it('maps a 429 to rate limiting with its retry-after and a 401 to a provider error, never echoing the key', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const limited = await failure(() => stub({
      status: 429, headers: { 'retry-after': '7' },
      body: { error: { message: 'Rate limit reached for requests', type: 'rate_limit_error', code: 'rate_limit_exceeded' } },
    }).provider.generate(request));
    expect(limited.code).toBe('rate_limited');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('7');

    const noHeader = await failure(() => stub({ status: 429, body: { error: { type: 'rate_limit_error', code: 'slow_down' } } }).provider.generate(request));
    expect(noHeader.code).toBe('rate_limited');
    expect(noHeader.headers['retry-after']).toBeUndefined();

    // Out of credit is also a 429, but waiting does not fix it.
    const broke = await failure(() => stub({ status: 429, body: { error: { type: 'insufficient_quota', code: 'credit_balance_exhausted' } } }).provider.generate(request));
    expect(broke.code).toBe('provider');

    const denied = await failure(() => stub({
      status: 401,
      body: { error: { message: `Incorrect API key provided: ${KEY}.`, type: 'invalid_request_error', code: 'invalid_api_key' } },
    }).provider.generate(request));
    expect(denied.code).toBe('provider');
    expect(denied.message).toMatch(/credentials/);

    const unreachable = await failure(() => createOpenAiProvider({
      apiKey: KEY, config, fetch: async () => { throw new TypeError('fetch failed'); },
    }).generate(request));
    expect(unreachable.code).toBe('provider');

    for (const e of [limited, noHeader, broke, denied, unreachable]) expect(e.message).not.toContain(KEY);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(KEY);
  });

  it('uses strict mode for the server schemas as written, and falls back when a schema does not qualify', async () => {
    for (const s of [SUMMARY_SCHEMA, REDUCE_SCHEMA, DETAIL_SCHEMA]) expect(strictSchemaIssues(s)).toEqual([]);

    const loose = {
      type: 'object',
      properties: {
        label: { type: 'string' },
        items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        extra: { not: { type: 'null' } },
      },
      required: ['label', 'items'],
      additionalProperties: false,
    };
    const issues = strictSchemaIssues(loose);
    expect(issues).toHaveLength(3); // `extra` is optional, the item object is open, `not` is unsupported
    expect(issues.join('\n')).toMatch(/\$\.extra: every property/);
    expect(issues.join('\n')).toMatch(/\$\.items\[\]: additionalProperties/);
    expect(issues.join('\n')).toMatch(/"not" is not supported/);
    expect(strictSchemaIssues({ anyOf: [schema] }).length).toBeGreaterThan(0);

    const { sent, provider } = stub(text({ label: 'Core', items: [{ id: 'a' }] }), text({ label: 'Core', items: [{}] }));
    expect((await provider.generate({ ...request, schema: loose })).outcome).toBe('ok');
    expect(sent[0].body.text.format.strict).toBe(false);
    // Not strict, so the shape is checked here.
    expect((await provider.generate({ ...request, schema: loose })).outcome).toBe('invalid');

    expect(matchesSchema({ pois: [], steps: [] }, REDUCE_SCHEMA)).toBe(true);
    expect(matchesSchema({ pois: [{ parent: 'u:a.ts' }], steps: [] }, REDUCE_SCHEMA)).toBe(false);
  });
});

describe('provider selection', () => {
  it('reads the provider from VITE_AI_PROVIDER, then AI_PROVIDER, then config, trimmed and lower-cased', () => {
    const openaiByConfig = withConfig({ ai: { provider: 'OpenAI' } });
    expect(resolveProviderId({}, config)).toBe(config.ai.provider);
    expect(resolveProviderId({}, openaiByConfig)).toBe('openai');
    expect(resolveProviderId({ AI_PROVIDER: 'anthropic' }, openaiByConfig)).toBe('anthropic');
    expect(resolveProviderId({ VITE_AI_PROVIDER: ' OpenAI ', AI_PROVIDER: 'anthropic' }, config)).toBe('openai');
    expect(resolveProviderId({ VITE_AI_PROVIDER: '', AI_PROVIDER: ' ' }, openaiByConfig)).toBe('openai');
  });

  it('gives the three model ids of the provider in use, from its own block in config', () => {
    expect(activeAi(config, { VITE_AI_PROVIDER: 'anthropic' })).toMatchObject({ provider: 'anthropic', models: config.ai.models });
    expect(activeAi(config, { VITE_AI_PROVIDER: 'openai' })).toMatchObject({ provider: 'openai', models: config.ai.openaiModels });
    expect(Object.keys(activeAi(config, {}).models).sort()).toEqual(['bulk', 'synthesis', 'tour']);

    const { synthesis, bulk } = config.ai.models;
    const older = { ...config, ai: { ...config.ai, models: { synthesis, bulk } } } as unknown as Config;
    expect(activeAi(older, { VITE_AI_PROVIDER: 'anthropic' }).models).toEqual({ synthesis, tour: synthesis, bulk });
  });

  it('names the missing variable of the selected provider, and rejects an unknown provider', () => {
    const error = (env: Record<string, string>) => {
      try {
        getProvider(env, config);
      } catch (e) {
        return e as AiError;
      }
      return expect.unreachable();
    };

    const openai = error({ VITE_AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'unused' });
    expect(openai.code).toBe('no_key');
    expect(openai.message).toContain('OPENAI_API_KEY');
    expect(openai.message).not.toContain('ANTHROPIC_API_KEY');

    const anthropic = error({ VITE_AI_PROVIDER: 'anthropic', OPENAI_API_KEY: 'unused' });
    expect(anthropic.code).toBe('no_key');
    expect(anthropic.message).toContain('ANTHROPIC_API_KEY');

    const unknown = error({ AI_PROVIDER: 'acme', OPENAI_API_KEY: 'unused' });
    expect(unknown.code).toBe('provider');
    expect(unknown.message).toContain('acme');

    expect(getProvider({ VITE_AI_PROVIDER: 'openai', OPENAI_API_KEY: KEY }, config).id).toBe('openai');
    expect(getProvider({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY }, config).id).toBe('anthropic');
  });
});

describe('pois route through the openai adapter', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  const poi = (parent: string, refs: string[] = []) => ({
    parent, label: 'Entry point', summary: words(LENGTHS.summary.target), kind: 'entry', evidence: 'Twelve units import it.', refs,
  });
  const body: PoisRequest = {
    digestHash: 'digest-1',
    refs: ['c:1', 'u:src/main.ts', 'u:src/store.ts'],
    digest: 'cities: c:1 (core). u:src/main.ts is the entry point.',
    summaries: [{ parent: 'c:1', label: 'Core', text: words(LENGTHS.summary.target) }],
    count: 2,
  };
  const call = async (provider: ReturnType<typeof stub>['provider']) => {
    const res = await handlers.pois(
      new Request('http://test.local/api/ai/pois', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      { provider, config, limiter: createMemoryLimiter(), now: () => 0 },
    );
    return { status: res.status, headers: res.headers, body: (await res.json()) as unknown };
  };

  it('returns the validated points of interest, and passes provider rate limiting on with its retry-after', async () => {
    const ok = stub(text({ pois: [poi('u:src/main.ts', ['c:1']), poi('u:invented.ts'), poi('u:src/store.ts')], steps: [] }));
    const res = await call(ok.provider);

    expect(res.status).toBe(200);
    expect((res.body as PoisResponse).pois.map((p) => p.parent)).toEqual(['u:src/main.ts', 'u:src/store.ts']);
    expect(ok.sent).toHaveLength(1);
    const sent = ok.sent[0].body;
    expect(sent.model).toBe(config.ai.openaiModels.synthesis);
    expect(sent.text.format).toMatchObject({ strict: true, schema: REDUCE_SCHEMA });
    expect(sent.input[1].content[0].text).toContain(body.digest);
    expect(sent.input[1].content).toHaveLength(2);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const limited = await call(stub({ status: 429, headers: { 'retry-after': '3' }, body: { error: { type: 'rate_limit_error' } } }).provider);
    expect(limited.status).toBe(429);
    expect((limited.body as AiErrorBody).error.code).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toBe('3');
  });
});
