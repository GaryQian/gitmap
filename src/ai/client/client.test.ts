// The client orchestration against the real handlers, with a scripted provider and no network.
// A fake `fetch` hands each request to `handlers[route]`, so the request bodies the client builds
// pass the server's own validation and the replies pass through its checks.
import { describe, expect, it } from 'vitest';
import { config, withConfig } from '../../config';
import type { Config } from '../../config';
import type { GenerateRequest, PoisRequest, TourRequest } from '../../contracts/ai';
import { DETAIL_QUESTIONS } from '../../contracts/ai';
import type { FileFacts, SyntaxFacts } from '../../contracts/lang';
import type { ModelStore } from '../../contracts/store';
import { createModelStore } from '../../model';
import type { ModelPatch, Poi, StructureTables } from '../../model/types';
import { syntheticMeta, syntheticTables, tablesToOps } from '../../testing/synthetic';
import {
  AiClientError, createAiClient, generateAnnotations, generateDetail, getConsent, poiCount, resetConsent, setConsent, shouldAsk,
} from '../index';
import type { ConsentStorage, DigestInput } from '../index';
import { createCannedProvider, createMemoryLimiter, handlers } from '../server';
import type { CannedReply, Deps, RouteName } from '../server';

const SECRET_FILE = 'city-0/district-0-0/.env.production';
const words = (n: number, word = 'word') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');

function addFile(tables: StructureTables, path: string): void {
  const u = tables.unit, f = tables.file;
  u.ids.push(path);
  u.cols.primaryFile!.push(path); u.cols.fileCount!.push(1); u.cols.loc!.push(12); u.cols.bytes!.push(400);
  u.cols.lang!.push('other'); u.cols.importancePct!.push(0.2); u.cols.fanIn!.push(0); u.cols.fanOut!.push(0);
  u.cols.district!.push(tables.district.ids[0]);
  f.ids.push(path);
  f.cols.lang!.push('other'); f.cols.bytes!.push(400); f.cols.loc!.push(12); f.cols.oid!.push(''); f.cols.unit!.push(path);
}

/** A small parsed repository in a real store, as the coordinator would hold it. */
function repo(cfg: Config = config): { store: ModelStore; input: DigestInput } {
  const tables = syntheticTables({ files: 90, cities: 3, districtsPerCity: 2, seed: 11 });
  addFile(tables, SECRET_FILE);
  const store = createModelStore();
  store.propose([{ op: 'meta', value: syntheticMeta('client-test', tables) }, ...tablesToOps(tables)]);
  const files: FileFacts[] = tables.file.ids.map((path, i) => ({
    path, oid: '', bytes: tables.file.cols.bytes![i], lang: tables.file.cols.lang![i], loc: tables.file.cols.loc![i], imports: [],
  }));
  const syntax: SyntaxFacts[] = tables.file.ids.filter((p) => p !== SECRET_FILE).map((path, i) => ({
    path, oid: '', refs: [],
    defs: [{ name: `run${i}`, kind: 'function' as const, line: 1, signature: `export function run${i}(input: Input): Output {`, doc: `Runs step ${i}.` }],
  }));
  return { store, input: { replica: store.replica, files, syntax, config: cfg } };
}

/** A provider that answers each route from what the request allows. */
function script(req: GenerateRequest): CannedReply {
  if (req.role === 'bulk') return { value: { label: 'Core services', text: words(30) } };
  const allowed = /<allowed_references>\n([\s\S]*?)\n<\/allowed_references>/.exec(req.cachedPrefix ?? '')?.[1].split('\n') ?? [];
  const files = allowed.filter((r) => r.startsWith('u:'));
  if (req.prompt.startsWith('Choose exactly')) {
    const count = Number(/Choose exactly (\d+)/.exec(req.prompt)![1]);
    const pois = Array.from({ length: count }, (_, i) => ({
      parent: files[i % files.length], label: `Point ${i}`, summary: words(30), kind: 'core', evidence: 'Many files import it.', refs: allowed.slice(0, 2),
    }));
    return { value: { pois, steps: [] } };
  }
  if (req.prompt.startsWith('Write a guided tour')) {
    const steps = Array.from({ length: config.ai.tour.minSteps }, (_, i) => ({
      parent: files[i % files.length], frame: i === 0 ? 'city' : 'file', text: words(20), highlights: files.slice(0, 2),
    }));
    return { value: { pois: [], steps } };
  }
  return { value: { markdown: 'It **routes** requests.' } };
}

interface Sent { route: RouteName; body: any }

/** `fetch`, answered by the real handlers. `intercept` may answer a request itself. */
function server(cfg: Config = config, intercept?: (sent: Sent, index: number) => Response | undefined) {
  const provider = createCannedProvider(script);
  const deps: Deps = { provider, config: cfg, limiter: createMemoryLimiter(), now: () => 0 };
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url).split('/').pop() as RouteName;
    const call: Sent = { route, body: JSON.parse(String(init!.body)) };
    sent.push(call);
    return intercept?.(call, sent.length - 1) ?? handlers[route](new Request(`http://test.local${String(url)}`, init), deps);
  }) as typeof globalThis.fetch;
  return { client: createAiClient({ fetch, sleep: async () => {} }), sent, provider };
}

const fast = { reduceHeadStartMs: 5 };
const errorBody = (code: string, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message: 'server words' } }), { status, headers });

describe('ai client orchestration', () => {
  it('runs map then reduce and returns summary, point-of-interest and tour operations with the digest hash', async () => {
    const { store, input } = repo();
    const { client, sent } = server();
    const emitted: ModelPatch[][] = [];
    const progress: { done: number; total: number }[] = [];
    let summariesDoneBeforeReduce = false;
    const result = await generateAnnotations({
      input, client, config, timing: fast,
      emit: (ops) => {
        // the summaries are in the store before the first reduce request is sent
        if (emitted.length === 0) summariesDoneBeforeReduce = !sent.some((s) => s.route !== 'summaries');
        emitted.push(ops);
        store.propose(ops); // the store accepts every operation
      },
      onProgress: (p) => progress.push({ ...p }),
    });

    expect(result.skipped).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.failure).toBeNull();
    expect(result.ops).toEqual(emitted.flat());

    const { annotations, meta } = store.replica;
    expect(meta?.digestHash).toBe(result.digestHash);
    expect(result.ops.filter((op) => op.op === 'meta')).toEqual([{ op: 'meta', value: { digestHash: result.digestHash } }]);
    const cities = store.replica.table('city').count;
    const summaries = annotations.filter((a) => a.type === 'summary');
    expect(summaries.map((s) => s.parent).sort()).toEqual(store.replica.table('city').slots().map((s) => `c:${store.replica.table('city').ids[s]}`).sort());
    // every city summary is a Summary annotation on its city (`c:` ref), with a stable id, a label and a text
    expect(summaries.every((s) => s.parent.startsWith('c:'))).toBe(true);
    for (const s of summaries) expect(s).toEqual({ type: 'summary', id: `summary:${s.parent.slice(2)}`, parent: s.parent, label: 'Core services', text: words(30) });

    const pois = annotations.filter((a): a is Poi => a.type === 'poi');
    expect(pois).toHaveLength(poiCount(store.replica, config));
    expect(new Set(pois.map((p) => p.id)).size).toBe(pois.length);
    for (const p of pois) {
      expect(store.replica.table('unit').has(p.parent.slice(2))).toBe(true);
      expect(Object.keys(p.details).sort()).toEqual(Object.keys(DETAIL_QUESTIONS).sort());
      expect(Object.values(p.details).every((d) => d.status === 'idle')).toBe(true);
    }
    const tours = annotations.filter((a) => a.type === 'tour');
    expect(tours).toHaveLength(1);
    expect(tours[0].steps.length).toBeGreaterThanOrEqual(config.ai.tour.minSteps);

    // all the summaries arrive first, in one emit, before any point of interest or the tour
    const kinds = emitted.map((ops) => [...new Set(ops.flatMap((op) => (op.op === 'annotation' ? [op.value.type] : [])))]);
    expect(kinds[0]).toEqual(['summary']);
    expect(emitted[0].filter((op) => op.op === 'annotation')).toHaveLength(cities);
    expect(kinds.slice(1).flat().sort()).toEqual(['poi', 'tour']);
    expect(summariesDoneBeforeReduce).toBe(true);
    expect(progress[0]).toEqual({ done: 0, total: cities + 2 });
    expect(progress.at(-1)).toEqual({ done: cities + 2, total: cities + 2 });
    expect(sent.map((s) => s.route).sort()).toEqual([...Array<string>(cities).fill('summaries'), 'pois', 'tour'].sort());
  });

  it('makes no request on a second run when the stored annotations are for the same digest', async () => {
    const { store, input } = repo();
    const first = server();
    await generateAnnotations({ input, client: first.client, timing: fast, emit: (ops) => store.propose(ops) });

    const second = server();
    const again = await generateAnnotations({ input, client: second.client, timing: fast });
    expect(again).toMatchObject({ skipped: true, ops: [], errors: [] });
    expect(again.digestHash).toBe(store.replica.meta?.digestHash);
    expect(second.sent).toHaveLength(0);

    // another digest (here: other models) replaces the stored set instead of reusing it
    const other = withConfig({ ai: { models: { synthesis: 'another-model' } } });
    const third = server(other);
    const replaced = await generateAnnotations({ input, config: other, client: third.client, timing: fast });
    expect(replaced.skipped).toBe(false);
    expect(replaced.digestHash).not.toBe(again.digestHash);
    const removed = replaced.ops.filter((op) => op.op === 'annotation' && op.action === 'remove');
    expect(removed).toHaveLength(store.replica.annotations.length);
    store.propose(replaced.ops);
    expect(store.replica.meta?.digestHash).toBe(replaced.digestHash);
    expect(store.replica.annotations.filter((a) => a.type === 'tour')).toHaveLength(1);
  });

  it('carries on when one city fails, and sends identical shared fields to the two reduce calls', async () => {
    const { store, input } = repo();
    const raw: Partial<Record<RouteName, string>> = {};
    const { client, sent } = server(config, (call, index) => {
      if (index === 0) return errorBody('provider', 502);
      return undefined;
    });
    const spy = createAiClient({
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const route = String(url).split('/').pop() as RouteName;
        if (route === 'pois' || route === 'tour') raw[route] = String(init!.body);
        return new Response('{}', { status: 599 }); // never used: only the bodies are looked at
      }) as typeof fetch,
    });
    const result = await generateAnnotations({
      input,
      timing: fast,
      emit: (ops) => store.propose(ops),
      client: {
        summaries: client.summaries,
        detail: client.detail,
        pois: (req, opts) => { void spy.pois(req, opts).catch(() => {}); return client.pois(req, opts); },
        tour: (req, opts) => { void spy.tour(req, opts).catch(() => {}); return client.tour(req, opts); },
      },
    });

    const cities = store.replica.table('city').count;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ stage: 'summaries', code: 'provider', city: sent[0].body.city });
    expect(result.failure).toBeNull(); // one city without a summary is not worth a line
    expect(store.replica.annotations.filter((a) => a.type === 'summary')).toHaveLength(cities - 1);
    expect(store.replica.annotations.some((a) => a.type === 'poi')).toBe(true);
    expect(store.replica.annotations.some((a) => a.type === 'tour')).toBe(true);

    const pois = sent.find((s) => s.route === 'pois')!.body as PoisRequest;
    const tour = sent.find((s) => s.route === 'tour')!.body as TourRequest;
    expect(pois.summaries).toHaveLength(cities - 1);
    expect(pois.digest.length).toBeGreaterThan(100);
    for (const field of ['digestHash', 'digest', 'summaries', 'refs'] as const) {
      expect(JSON.stringify(tour[field]), field).toBe(JSON.stringify(pois[field]));
    }
    // byte for byte on the wire as well: the shared fields come first and in the same order
    const sharedPart = (body: string) => body.slice(0, body.lastIndexOf('"summaries"')) + JSON.stringify(JSON.parse(body).summaries);
    expect(sharedPart(raw.tour!)).toBe(sharedPart(raw.pois!));
    // the tour follows the points of interest; it is never sent first
    expect(sent.findIndex((s) => s.route === 'pois')).toBeLessThan(sent.findIndex((s) => s.route === 'tour'));
  });

  it('keeps the points of interest when the tour fails, and asks only for the tour the next time', async () => {
    const { store, input } = repo();
    const failing = server(config, (call) => (call.route === 'tour' ? errorBody('rate_limited', 429, { 'retry-after': '40' }) : undefined));
    const first = await generateAnnotations({ input, client: failing.client, timing: fast, emit: (ops) => store.propose(ops) });
    expect(first.failure).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 40 });
    expect(first.failure!.message).toContain('40 seconds');
    expect(store.replica.annotations.some((a) => a.type === 'poi')).toBe(true);
    expect(store.replica.annotations.some((a) => a.type === 'tour')).toBe(false);

    const working = server();
    const second = await generateAnnotations({ input, client: working.client, timing: fast, emit: (ops) => store.propose(ops) });
    expect(working.sent.map((s) => s.route)).toEqual(['tour']);
    expect(second.errors).toEqual([]);
    expect(store.replica.annotations.some((a) => a.type === 'tour')).toBe(true);
  });

  it('stops at once when the server has no key, and leaves the stored set alone', async () => {
    const { store, input } = repo();
    const { client, sent } = server(config, () => errorBody('no_key', 503));
    const result = await generateAnnotations({ input, client, timing: { ...fast, summaryConcurrency: 1 } });
    expect(sent).toHaveLength(1);
    expect(result.ops).toEqual([]);
    expect(result.failure).toMatchObject({ code: 'no_key' });
    expect(store.replica.meta?.digestHash).toBeUndefined();
  });

  it('answers a detail button through the model: loading, then ready', async () => {
    const { store, input } = repo();
    const { client, sent } = server();
    await generateAnnotations({ input, client, timing: fast, emit: (ops) => store.propose(ops) });
    const poi = store.replica.annotations.find((a): a is Poi => a.type === 'poi')!;
    const before = sent.length;

    const statuses: string[] = [];
    const result = await generateDetail({
      input, poi, question: 'role', client,
      emit: (ops) => {
        store.propose(ops);
        statuses.push(store.replica.annotations.find((a): a is Poi => a.type === 'poi' && a.id === poi.id)!.details.role.status);
      },
    });
    expect(statuses).toEqual(['loading', 'ready']);
    expect(result).toMatchObject({ status: 'ready', withheld: null, error: null });
    const stored = store.replica.annotations.find((a): a is Poi => a.type === 'poi' && a.id === poi.id)!;
    expect(stored.details.role).toEqual({ status: 'ready', markdown: 'It **routes** requests.' });
    expect(stored.details.users).toEqual({ status: 'idle' });
    expect(sent.slice(before).map((s) => s.route)).toEqual(['detail']);
    expect(sent.at(-1)!.body).toMatchObject({ digestHash: store.replica.meta!.digestHash, question: 'role', poi: { parent: poi.parent } });

    // a failed call ends in `error`, with the reason for the chrome
    const down = server(config, () => errorBody('refused', 422));
    const failed = await generateDetail({ input, poi, question: 'users', client: down.client });
    expect(failed.status).toBe('error');
    expect(failed.error).toMatchObject({ code: 'refused' });
    expect(failed.ops.map((op) => (op.op === 'annotation' ? (op.value as Poi).details.users.status : ''))).toEqual(['loading', 'error']);
  });

  it('never sends a withheld file: the detail says so and no request is made', async () => {
    const { input } = repo();
    const { client, sent } = server();
    const poi: Poi = {
      type: 'poi', id: 'poi:secret', parent: `u:${SECRET_FILE}`, label: 'Settings', summary: 'Deployment settings.', kind: 'data', evidence: '',
      details: { role: { status: 'idle' } },
    };
    const result = await generateDetail({ input, poi, question: 'role', client, fileText: 'API_TOKEN=abc' });
    expect(sent).toHaveLength(0);
    expect(result.withheld).toBe('secret');
    expect(result.ops).toHaveLength(1);
    const detail = (result.ops[0] as Extract<ModelPatch, { op: 'annotation' }>).value as Poi;
    expect(detail.details.role.status).toBe('ready');
    expect(detail.details.role.markdown).toMatch(/withheld from the AI model/);
  });
});

describe('ai http client', () => {
  it('turns error bodies into typed errors and retries a short rate limit once', async () => {
    const answers = [
      errorBody('rate_limited', 429, { 'retry-after': '2' }),
      new Response(JSON.stringify({ markdown: 'ok' }), { status: 200 }),
      errorBody('rate_limited', 429, { 'retry-after': '120' }),
      new Response('<html>not found</html>', { status: 404 }),
    ];
    let calls = 0;
    const waits: number[] = [];
    const client = createAiClient({
      fetch: (async () => answers[calls++]) as unknown as typeof fetch,
      sleep: async (ms) => { waits.push(ms); },
    });
    const req = { digestHash: 'h', refs: [], poi: { parent: 'u:a.ts' as const, label: 'A', summary: 'B' }, question: 'role' as const, context: 'c' };

    await expect(client.detail(req)).resolves.toEqual({ markdown: 'ok' });
    expect(calls).toBe(2);
    expect(waits).toEqual([2000]);

    const limited = await client.detail(req).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(AiClientError);
    expect(limited).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 120, status: 429, detail: 'server words' });
    expect(calls).toBe(3); // a long wait is not retried

    await expect(client.detail(req)).rejects.toMatchObject({ code: 'unavailable' });

    const offline = createAiClient({ fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    await expect(offline.detail(req)).rejects.toMatchObject({ code: 'network' });

    const abort = new AbortController();
    abort.abort();
    await expect(client.detail(req, { signal: abort.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(calls).toBe(4);
  });
});

describe('ai consent', () => {
  it('remembers an answer per repository and can forget it', () => {
    const data = new Map<string, string>();
    const storage: ConsentStorage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
    expect(getConsent('repo-a', storage)).toBeNull();
    setConsent('repo-a', 'declined', storage);
    setConsent('repo-b', 'granted', storage);
    expect(getConsent('repo-a', storage)).toBe('declined');
    expect(getConsent('repo-b', storage)).toBe('granted');
    resetConsent('repo-a', storage);
    expect(getConsent('repo-a', storage)).toBeNull();
    expect(getConsent('repo-b', storage)).toBe('granted');
    expect(getConsent('repo-a', null)).toBeNull(); // no storage at all
  });

  it('asks only when AI is on, the map is not a demo, nothing is stored and nobody has answered', () => {
    const off = withConfig({ ai: { enabled: false } });
    const on = withConfig({ ai: { enabled: true } });
    const summary = { type: 'summary' as const, id: 'summary:c:1', parent: 'c:1' as const, text: 'x' };
    const git = { source: 'git' as const };
    expect(shouldAsk({ config: on, meta: git, annotations: [], consent: null })).toBe(true);
    expect(shouldAsk({ config: off, meta: git, annotations: [], consent: null })).toBe(false);
    expect(shouldAsk({ config: on, meta: { source: 'demo' }, annotations: [], consent: null })).toBe(false);
    expect(shouldAsk({ config: on, meta: null, annotations: [], consent: null })).toBe(false);
    expect(shouldAsk({ config: on, meta: git, annotations: [], consent: 'granted' })).toBe(false);
    expect(shouldAsk({ config: on, meta: git, annotations: [], consent: 'declined' })).toBe(false);
    expect(shouldAsk({ config: on, meta: { source: 'git', digestHash: 'abc' }, annotations: [summary], consent: null })).toBe(false);
    // annotations without a digest hash were not generated here for this model: still ask
    expect(shouldAsk({ config: on, meta: git, annotations: [summary], consent: null })).toBe(true);
  });
});
