import { describe, expect, it } from 'vitest';
import { config } from '../config';
import type { FileFacts, SyntaxFacts } from '../contracts/lang';
import { decodeModel, encodeModel, type RepoModel } from '../model';
import { syntheticMeta, syntheticTables } from '../testing/synthetic';
import {
  createFactsCache, createSnapshotStore, createSnapshotWriter, hasChanged, memoryBlobStore, memoryFactsBackend,
  memoryRegistry, openPersistence, recordFromModel, snapshotFileName,
} from './index';

function model(name = 'demo', files = 120): RepoModel {
  const tables = syntheticTables({ files, seed: 7 });
  return {
    schema: 1,
    meta: { ...syntheticMeta(name, tables), parserVersion: config.parser.version, headOid: 'a'.repeat(40), indexChecksum: 'b'.repeat(40) },
    tables: { ...tables, contributor: { ids: ['c1'], cols: { name: ['Ada'], emails: ['ada@example.com'], commits: [3] } } },
    layers: {},
    annotations: { pois: [], tours: [], summaries: [] },
    layout: { unit: { ids: [tables.unit.ids[0]], xz: [1.5, -2] }, district: { ids: [], xzr: [] }, city: { ids: [], xzr: [] }, home: { district: [], city: [] } },
  };
}

async function gzipJson(doc: unknown): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(doc)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzipJson(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

describe('snapshots', () => {
  it('round-trips a model, keyed by repo id', async () => {
    const snapshots = createSnapshotStore(memoryBlobStore());
    const a = model('one'), b = model('Two/with spaces', 40);
    await snapshots.save(a);
    await snapshots.save(b);
    expect(await snapshots.load(a.meta.id)).toEqual(a);
    expect(await snapshots.load(b.meta.id)).toEqual(b);
    expect((await snapshots.list()).sort()).toEqual([a.meta.id, b.meta.id].sort());
    expect(await snapshots.load('synthetic:unknown')).toBeNull();
    await snapshots.remove(a.meta.id);
    expect(await snapshots.load(a.meta.id)).toBeNull();
    expect(await snapshots.list()).toEqual([b.meta.id]);
  });

  it('gives different, filesystem-safe names to ids that differ only in case or punctuation', async () => {
    const ids = ['git:https://github.com/a/b.git', 'git:https://github.com/A/b.git', 'git:https:/github.com/a/b.git', 'local:a_b', 'local:a b', 'x'.repeat(400), 'x'.repeat(401)];
    const names = await Promise.all(ids.map(snapshotFileName));
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(ids.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9._~-]{1,200}$/);
  });

  it('rejects and removes a snapshot from another parser version, another schema, or cut short', async () => {
    const blobs = memoryBlobStore();
    const rejected: string[] = [];
    const snapshots = createSnapshotStore(blobs, { onReject: (id, reason) => rejected.push(`${id} ${reason}`) });
    const m = model();
    const name = await snapshotFileName(m.meta.id);
    const good = await encodeModel(m);

    // another parser version
    await blobs.put(name, await encodeModel({ ...m, meta: { ...m.meta, parserVersion: config.parser.version + '-old' } }));
    expect(await snapshots.load(m.meta.id)).toBeNull();
    expect(await blobs.list()).toEqual([]);

    // another schema
    await blobs.put(name, await gzipJson({ ...(await gunzipJson(good)), schema: 999 }));
    expect(await snapshots.load(m.meta.id)).toBeNull();
    expect(await blobs.list()).toEqual([]);

    // a write that stopped half way
    await blobs.put(name, good.slice(0, good.length >> 1));
    expect(await snapshots.load(m.meta.id)).toBeNull();
    expect(await blobs.list()).toEqual([]);

    expect(rejected).toEqual([`${m.meta.id} parserVersion`, `${m.meta.id} unreadable`, `${m.meta.id} unreadable`]);

    // and the current one still loads
    await blobs.put(name, good);
    expect(await snapshots.load(m.meta.id)).toEqual(await decodeModel(good));
  });
});

describe('snapshot writer', () => {
  const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function slowStore() {
    const state = { saves: [] as number[], active: 0, overlapped: false, fail: false };
    const store = {
      async save(m: RepoModel) {
        if (++state.active > 1) state.overlapped = true;
        await tick(5);
        state.active--;
        if (state.fail) throw new Error('quota');
        state.saves.push(m.meta.parsedAt);
        return 1;
      },
    };
    return { state, store };
  }

  it('coalesces a burst into one save, and flush waits for the newest model to be stored', async () => {
    const { state, store } = slowStore();
    const m = model();
    let version = 0;
    const getModel = () => ({ ...m, meta: { ...m.meta, parsedAt: version } });
    const writer = createSnapshotWriter({ store, getModel, debounceMs: 20 });

    for (let i = 0; i < 10; i++) { version++; writer.schedule(); }
    expect(writer.pending).toBe(true);
    expect(state.saves).toEqual([]);
    await tick(80);
    expect(state.saves).toEqual([10]);
    expect(writer.pending).toBe(false);

    // flush does not wait for the window, and covers a change made while a save is running
    version = 11;
    writer.schedule();
    const first = writer.flush();
    version = 12;
    await Promise.all([first, writer.flush(), writer.flush()]);
    expect(state.saves[state.saves.length - 1]).toBe(12);
    expect(state.saves.length).toBeLessThanOrEqual(3);
    expect(state.overlapped).toBe(false);

    const before = state.saves.length;
    await tick(60);
    expect(state.saves.length).toBe(before); // nothing left over from the flushed burst
  });

  it('reports a failed save through onError and keeps working', async () => {
    const { state, store } = slowStore();
    const errors: unknown[] = [];
    const m = model();
    const writer = createSnapshotWriter({ store, getModel: () => m, debounceMs: 1, onError: (e) => errors.push(e) });
    state.fail = true;
    writer.schedule();
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    state.fail = false;
    await writer.flush();
    expect(state.saves).toHaveLength(1);
  });
});

describe('facts cache', () => {
  const facts = (oid: string, path: string): FileFacts => ({ path, oid, bytes: 10, lang: 'ts', loc: 2, imports: [{ spec: './x', kind: 'import' }] });
  const syntax = (oid: string, path: string): SyntaxFacts => ({ path, oid, defs: [{ name: 'f', kind: 'function', line: 1 }], refs: [] });

  it('returns what was stored under an oid, and nothing for an unknown oid, an empty oid or another parser version', async () => {
    const backend = memoryFactsBackend();
    const cache = createFactsCache(backend, { parserVersion: '1' });
    const a = facts('aa', 'a.ts'), b = facts('bb', 'b.ts'), untracked = facts('', 'new.ts');
    await cache.putFacts([a, b, untracked]);
    await cache.putSyntax([syntax('aa', 'a.ts'), syntax('', 'new.ts')]);

    const got = await cache.getFacts(['aa', 'bb', 'cc', '', 'aa']);
    expect([...got.keys()].sort()).toEqual(['aa', 'bb']);
    expect(got.get('aa')).toEqual(a);
    expect(got.get('bb')).toEqual(b);
    expect([...(await cache.getSyntax(['aa', 'bb', ''])).entries()]).toEqual([['aa', syntax('aa', 'a.ts')]]);

    const next = createFactsCache(backend, { parserVersion: '2' });
    expect((await next.getFacts(['aa', 'bb'])).size).toBe(0);
    expect((await next.getSyntax(['aa'])).size).toBe(0);

    // pruning from the new version drops the old version's entries and keeps its own
    await next.putFacts([facts('dd', 'd.ts')]);
    expect(await next.prune(60_000)).toBe(3);
    expect((await next.getFacts(['dd'])).size).toBe(1);
    expect((await cache.getFacts(['aa'])).size).toBe(0);
  });
});

describe('registry', () => {
  it('lists most recently opened first, and never keeps a locator that cannot be reopened', async () => {
    let clock = 1000;
    const registry = memoryRegistry(() => clock);
    const a = model('a'), b = model('b'), c = model('c');
    await registry.put(recordFromModel(a, { kind: 'node', rootPath: '/repos/a' }, 100));
    await registry.put(recordFromModel(b, { kind: 'memory', name: 'b', files: {} }, 300));
    await registry.put(recordFromModel(c, undefined, 200));
    expect((await registry.list()).map((r) => r.name)).toEqual(['b', 'c', 'a']);

    await registry.touch(a.meta.id);
    await registry.touch('synthetic:unknown');
    expect((await registry.list()).map((r) => r.name)).toEqual(['a', 'b', 'c']);

    const stored = await registry.get(a.meta.id);
    expect(stored).toMatchObject({ id: a.meta.id, headOid: a.meta.headOid, indexChecksum: a.meta.indexChecksum, schema: 1, parserVersion: config.parser.version, lastOpened: clock });
    expect(stored?.locator).toEqual({ kind: 'node', rootPath: '/repos/a' });
    expect((await registry.get(b.meta.id))?.locator).toBeUndefined();

    expect(hasChanged(stored!, { headOid: a.meta.headOid, indexChecksum: a.meta.indexChecksum })).toBe(false);
    expect(hasChanged(stored!, { headOid: a.meta.headOid, indexChecksum: 'c'.repeat(40) })).toBe(true);

    await registry.remove(b.meta.id);
    expect(await registry.get(b.meta.id)).toBeNull();
    clock++;
  });
});

describe('openPersistence', () => {
  it('falls back to the in-memory backends where there is no OPFS or IndexedDB (Node)', async () => {
    const p = await openPersistence();
    expect(p.kind).toBe('memory');
    const m = model();
    await p.snapshots.save(m);
    await p.registry.put(recordFromModel(m));
    expect(await p.snapshots.load(m.meta.id)).toEqual(m);
    expect((await p.registry.list()).map((r) => r.id)).toEqual([m.meta.id]);
    p.close();
  });
});
