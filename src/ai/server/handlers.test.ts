import { describe, expect, it } from 'vitest';
import { config, withConfig } from '../../config';
import type { Config } from '../../config';
import type {
  AiErrorBody, DetailRequest, PoisRequest, PoisResponse, SummariesRequest, SummariesResponse, TourRequest, TourResponse,
} from '../../contracts/ai';
import type { NodeRef } from '../../model/types';
import { AiError, createCannedProvider, createMemoryLimiter, handlers } from './index';
import type { CannedProvider, CannedScript, Deps, RouteName } from './index';
import { LENGTHS } from './prompts';

const REFS: NodeRef[] = ['c:1', 'c:2', 'u:src/main.ts', 'u:src/store.ts', 'u:src/http/server.ts'];

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const summaryText = words(LENGTHS.summary.target);
const stepText = words(LENGTHS.step.max);

function setup(script: CannedScript, cfg: Config = config): { provider: CannedProvider; deps: Deps } {
  const provider = createCannedProvider(script);
  return { provider, deps: { provider, config: cfg, limiter: createMemoryLimiter(), now: () => 0 } };
}

async function call<T>(route: RouteName, deps: Deps, body: unknown): Promise<{ status: number; body: T }> {
  const request = new Request(`http://test.local/api/ai/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify(body),
  });
  const res = await handlers[route](request, deps);
  return { status: res.status, body: (await res.json()) as T };
}

const poisBody = (over: Partial<PoisRequest> = {}): PoisRequest => ({
  digestHash: 'digest-1',
  refs: REFS,
  digest: 'cities: c:1 (core), c:2 (http). u:src/main.ts is the entry point.',
  summaries: [{ parent: 'c:1', label: 'Core', text: summaryText }],
  count: 2,
  ...over,
});
const tourBody = (): TourRequest => {
  const { count: _count, ...shared } = poisBody();
  return { ...shared, minSteps: config.ai.tour.minSteps, maxSteps: config.ai.tour.maxSteps };
};
const poi = (parent: string, refs: string[] = []) => ({
  parent, label: 'Entry point', summary: summaryText, kind: 'entry', evidence: 'Twelve units import it.', refs,
});
const step = (target: string, text = stepText) => ({ target, text, highlights: [] as string[] });

describe('ai server handlers', () => {
  it('returns validated points of interest for a valid request', async () => {
    const { provider, deps } = setup([{ value: { pois: [poi('u:src/main.ts', ['c:1']), poi('u:src/store.ts')], steps: [] } }]);
    const res = await call<PoisResponse>('pois', deps, poisBody());

    expect(res.status).toBe(200);
    expect(res.body.pois.map((p) => p.parent)).toEqual(['u:src/main.ts', 'u:src/store.ts']);
    expect(res.body.pois[0]).toMatchObject({ kind: 'entry', refs: ['c:1'] });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].role).toBe('synthesis');
  });

  it('drops items that cite unknown references and strips unknown entries from ref lists', async () => {
    const { provider, deps } = setup([{
      value: {
        pois: [poi('u:src/main.ts', ['c:1', 'u:not/in/the/list.ts']), poi('u:invented.ts'), poi('u:src/store.ts')],
        steps: [],
      },
    }]);
    const res = await call<PoisResponse>('pois', deps, poisBody());

    expect(res.status).toBe(200);
    expect(res.body.pois.map((p) => p.parent)).toEqual(['u:src/main.ts', 'u:src/store.ts']);
    expect(res.body.pois[0].refs).toEqual(['c:1']);
    expect(provider.requests).toHaveLength(1); // two usable items were asked for and two remain: no retry
  });

  it('retries exactly once when a reply breaks the length rules, saying what was wrong', async () => {
    const tooLong = words(LENGTHS.summary.tolerated[1] * 3);
    const { provider, deps } = setup([
      { value: { label: 'Core', text: tooLong } },
      { value: { label: 'Core', text: summaryText } },
    ]);
    const body: SummariesRequest = { digestHash: 'digest-1', refs: REFS, city: 'c:1', context: 'district d:1 holds the stores.' };
    const res = await call<SummariesResponse>('summaries', deps, body);

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ parent: 'c:1', label: 'Core', text: summaryText });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0].role).toBe('bulk');
    expect(provider.requests[1].prompt).toContain('rejected');

    // Still wrong after the retry: no third call, and nothing invalid is returned.
    const again = setup([{ value: { label: 'Core', text: tooLong } }, { value: { label: 'Core', text: tooLong } }]);
    const failed = await call<SummariesResponse>('summaries', again.deps, body);
    expect(failed.body.summary).toBeNull();
    expect(again.provider.requests).toHaveLength(2);
  });

  it('maps a refusal to the refused error', async () => {
    const { provider, deps } = setup([{ outcome: 'refusal' }]);
    const res = await call<AiErrorBody>('tour', deps, tourBody());

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('refused');
    expect(provider.requests).toHaveLength(1);
  });

  it('rejects an oversized request before the provider is called', async () => {
    const small = withConfig({ ai: { maxInputTokens: 200 } });
    const { provider, deps } = setup([], small);
    const res = await call<AiErrorBody>('pois', deps, poisBody({ digest: words(small.ai.maxInputTokens * 20) }));

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('too_large');
    expect(provider.requests).toHaveLength(0);
    expect(provider.counted).toHaveLength(0);
  });

  it('enforces the detail cap per digest', async () => {
    const capped = withConfig({ ai: { maxDetailCallsPerDigest: 2 } });
    const { deps } = setup(() => ({ value: { markdown: 'It starts the server.' } }), capped);
    const body = (digestHash: string): DetailRequest => ({
      digestHash, refs: REFS, question: 'role', context: 'export function main(): void',
      poi: { parent: 'u:src/main.ts', label: 'Entry point', summary: summaryText },
    });

    expect((await call('detail', deps, body('digest-1'))).status).toBe(200);
    expect((await call('detail', deps, body('digest-1'))).status).toBe(200);
    const third = await call<AiErrorBody>('detail', deps, body('digest-1'));
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('rate_limited');
    expect((await call('detail', deps, body('digest-2'))).status).toBe(200);
  });

  it('gives the tour the same cacheable prefix, system prompt and output format as the points of interest', async () => {
    const steps = REFS.slice(0, config.ai.tour.minSteps).map((r) => step(r));
    const { provider, deps } = setup([
      { value: { pois: [poi('u:src/main.ts'), poi('u:src/store.ts')], steps: [] } },
      { value: { pois: [], steps: [...steps, step('u:invented.ts')] } },
    ]);
    await call('pois', deps, poisBody());
    const res = await call<TourResponse>('tour', deps, tourBody());

    expect(res.status).toBe(200);
    expect(res.body.steps.map((s) => s.target)).toEqual(steps.map((s) => s.target));
    const [a, b] = provider.requests;
    expect(a.cachedPrefix).toContain(poisBody().digest);
    expect(b.cachedPrefix).toBe(a.cachedPrefix);
    expect(b.system).toBe(a.system);
    expect(b.schema).toEqual(a.schema);
  });

  it('answers disabled, no_key, wrong method and malformed bodies without calling the provider', async () => {
    const { provider, deps } = setup([]);
    const code = async (route: RouteName, d: Deps, body: unknown) => (await call<AiErrorBody>(route, d, body)).body.error.code;

    expect(await code('pois', { ...deps, config: withConfig({ ai: { enabled: false } }) }, poisBody())).toBe('disabled');
    expect(await code('pois', { ...deps, provider: new AiError('no_key', 'no key') }, poisBody())).toBe('no_key');
    expect(await code('pois', deps, { ...poisBody(), refs: ['not-a-ref'] })).toBe('invalid');
    expect(await code('pois', deps, poisBody({ count: config.ai.pois.max + 1 }))).toBe('invalid');
    const get = await handlers.pois(new Request('http://test.local/api/ai/pois'), deps);
    expect(get.status).toBe(405);
    expect(provider.requests).toHaveLength(0);
  });
});
