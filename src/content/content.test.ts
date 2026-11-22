// The facts worth pinning (IMPLEMENTATION.md §3, "Content"): a zip entry read by range equals the
// original file, a hash mismatch is caught, and the whole-file fallback works.
import { zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createModelStore, type RepoModel } from '../model';
import { gitBlobOid } from '../shared';
import { syntheticMeta, syntheticTables, tablesToOps } from '../testing/synthetic';
import {
  ContentMismatchError, demoSource, directorySource, exportModelFile, importModelFile, modelFileName, type ContentCache,
} from './index';

const enc = new TextEncoder();
const dec = new TextDecoder();

function syntheticModel(files: number): RepoModel {
  const tables = syntheticTables({ files, seed: 5 });
  const store = createModelStore();
  store.propose([{ op: 'meta', value: syntheticMeta('export-test', tables) }, ...tablesToOps(tables)]);
  return store.toModel();
}

/** Text that deflates well, so a range read is visibly smaller than the file. */
const body = (name: string, lines: number): Uint8Array =>
  enc.encode(Array.from({ length: lines }, (_, i) => `export const ${name}${i} = ${i}; // ${name}\n`).join(''));

const FILES: Record<string, Uint8Array> = {
  'src/app/main.ts': body('main', 400),
  'src/lib/útil.ts': body('util', 900),
  'docs/notes.md': enc.encode('# Notes\n\nShort, stored without compression.\n'),
  'empty.txt': new Uint8Array(0),
  'LICENSE': enc.encode('MIT License\n\nCopyright (c) someone\n'),
};

function buildZip(files: Record<string, Uint8Array> = FILES): Uint8Array {
  const input: Zippable = {};
  for (const [path, bytes] of Object.entries(files)) input[path] = [bytes, { level: path.endsWith('.md') ? 0 : 6 }];
  return zipSync(input);
}

async function oidTable(files: Record<string, Uint8Array> = FILES): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(files)) if (path !== 'LICENSE') out[path] = await gitBlobOid(bytes);
  return out;
}

interface FakeHost { fetch: typeof fetch; requests: { range: string | null; bytes: number }[] }

/** A static host for one file. `ranges: false` answers every request with the whole file and a 200. */
function fakeHost(zip: Uint8Array, opts: { ranges?: boolean; failRanges?: boolean; misreadSuffix?: boolean } = {}): FakeHost {
  const requests: FakeHost['requests'] = [];
  const send = (range: string | null, status: number, bytes: Uint8Array, headers: Record<string, string> = {}): Response => {
    requests.push({ range, bytes: bytes.length });
    return new Response(bytes.slice(), { status, headers });
  };
  const fetchFake = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const range = new Headers(init?.headers).get('Range');
    if (!range || opts.ranges === false) return send(range, 200, zip);
    if (opts.failRanges) throw new TypeError('network error');
    const suffix = /^bytes=-(\d+)$/.exec(range);
    const span = /^bytes=(\d+)-(\d+)$/.exec(range);
    // sirv (the server behind `vite` and `vite preview`) answers "bytes=-N" with bytes 0-N
    const fromEnd = suffix && !opts.misreadSuffix;
    const start = suffix ? (fromEnd ? Math.max(0, zip.length - Number(suffix[1])) : 0) : Number(span![1]);
    const end = fromEnd ? zip.length - 1 : Math.min(zip.length - 1, Number((suffix ?? span)![suffix ? 1 : 2]));
    return send(range, 206, zip.subarray(start, end + 1), { 'Content-Range': `bytes ${start}-${end}/${zip.length}` });
  };
  return { fetch: fetchFake as typeof fetch, requests };
}

function memoryCache(): ContentCache & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async match(url) { const b = store.get(url); return b ? new Response(b.slice()) : undefined; },
    async put(url, res) { store.set(url, new Uint8Array(await res.arrayBuffer())); },
    async delete(url) { return store.delete(url); },
  };
}

describe('demoSource', () => {
  it('reads one zip entry by range, equal to the original file', async () => {
    const zip = buildZip();
    const oids = await oidTable();
    const host = fakeHost(zip);
    const source = demoSource('/demo/t/', { oidOf: (p) => oids[p], fetch: host.fetch, cache: null });

    expect(await source.read('f:src/app/main.ts')).toEqual(FILES['src/app/main.ts']);
    expect(await source.read('u:src/lib/útil.ts')).toEqual(FILES['src/lib/útil.ts']); // a unit's primary file, deflated, non-ASCII name
    expect(dec.decode(await source.read('f:docs/notes.md'))).toContain('stored without compression'); // stored entry
    expect((await source.read('f:empty.txt')).length).toBe(0);
    expect(dec.decode(await source.read('f:LICENSE'))).toMatch(/^MIT License/); // no recorded oid: served unverified
    expect(source.mode).toBe('range');
    expect(host.requests.every((r) => r.range !== null)).toBe(true);
    expect((await source.paths()).sort()).toEqual(Object.keys(FILES).sort());
    await expect(source.read('f:missing.ts')).rejects.toThrow(/not among the demo's files/);
    await expect(source.read('d:some-district')).rejects.toThrow(/Only a file/);
  });

  it('downloads only the directory and the entry asked for', async () => {
    // big enough that the directory and one entry are a small part of it
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 40; i++) files[`src/f${i}.ts`] = body(`f${i}_`, 2000 + i);
    const zip = buildZip(files);
    const oids = await oidTable(files);
    const host = fakeHost(zip);
    const source = demoSource('/demo/t', { oidOf: (p) => oids[p], fetch: host.fetch, cache: null, tailBytes: 1 });
    // the smallest tail the reader asks for (one full end record) must not cover this archive
    expect(zip.length).toBeGreaterThan(3 * 65557);
    expect(await source.read('f:src/f7.ts')).toEqual(files['src/f7.ts']);
    expect(host.requests.length).toBe(2);
    const fetched = host.requests.reduce((n, r) => n + r.bytes, 0);
    expect(fetched).toBeLessThan(zip.length / 2);
  });

  it('still reads by range from a host that misreads the suffix range', async () => {
    const zip = buildZip();
    const oids = await oidTable();
    const host = fakeHost(zip, { misreadSuffix: true });
    const source = demoSource('/demo/t/', { oidOf: (p) => oids[p], fetch: host.fetch, cache: null });
    expect(await source.read('f:src/lib/útil.ts')).toEqual(FILES['src/lib/útil.ts']);
    expect(source.mode).toBe('range');
    expect(host.requests.every((r) => r.range !== null)).toBe(true);
  });

  it('detects a file that is not the version the map recorded', async () => {
    const zip = buildZip();
    const oids = await oidTable();
    oids['src/app/main.ts'] = await gitBlobOid(enc.encode('some other version\n'));
    const source = demoSource('/demo/t/', { oidOf: (p) => oids[p], fetch: fakeHost(zip).fetch, cache: null });
    const err = await source.read('f:src/app/main.ts').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ContentMismatchError);
    expect((err as Error).message).toMatch(/does not match the map/);
    // other files are unaffected
    expect(await source.read('f:docs/notes.md')).toEqual(FILES['docs/notes.md']);
  });

  it('falls back to one download of the whole archive when the host ignores Range', async () => {
    const zip = buildZip();
    const oids = await oidTable();
    const host = fakeHost(zip, { ranges: false });
    const source = demoSource('/demo/t/', { oidOf: (p) => oids[p], fetch: host.fetch, cache: null });
    for (const path of Object.keys(FILES)) expect(await source.read(`f:${path}`)).toEqual(FILES[path]);
    expect(source.mode).toBe('whole');
    expect(host.requests.length).toBe(1); // every later read is served from the copy that was kept
  });

  it('falls back to the whole archive when range requests fail', async () => {
    const zip = buildZip();
    const oids = await oidTable();
    const host = fakeHost(zip, { failRanges: true });
    const source = demoSource('/demo/t/', { oidOf: (p) => oids[p], fetch: host.fetch, cache: null });
    expect(await source.read('f:src/app/main.ts')).toEqual(FILES['src/app/main.ts']);
    expect(await source.read('f:src/lib/útil.ts')).toEqual(FILES['src/lib/útil.ts']);
    expect(source.mode).toBe('whole');
    expect(host.requests.filter((r) => r.range === null).length).toBe(1);
  });

  it('serves a reopened file from the cache with no request', async () => {
    const zip = buildZip();
    const oids = await oidTable();
    const cache = memoryCache();
    const first = demoSource('/demo/t/', { oidOf: (p) => oids[p], fetch: fakeHost(zip).fetch, cache });
    await first.read('f:src/app/main.ts');
    await new Promise((r) => setTimeout(r, 0)); // the cache write is not awaited by the read
    expect(cache.store.size).toBe(1);

    const offline = demoSource('/demo/t/', {
      oidOf: (p) => oids[p], cache,
      fetch: (async () => { throw new TypeError('offline'); }) as typeof fetch,
    });
    expect(await offline.read('f:src/app/main.ts')).toEqual(FILES['src/app/main.ts']);
  });
});

describe('directorySource', () => {
  it('reads working-tree files from a dropped file list and is null for other locators', async () => {
    const file = new File([FILES['src/app/main.ts'] as Uint8Array<ArrayBuffer>], 'main.ts');
    const source = directorySource({ kind: 'files', name: 'repo', files: [{ path: 'src/app/main.ts', file }] });
    expect(await source!.read('u:src/app/main.ts')).toEqual(FILES['src/app/main.ts']);
    await expect(source!.read('f:gone.ts')).rejects.toThrow(/Could not read "gone.ts"/);
    expect(directorySource({ kind: 'node', rootPath: '/tmp/x' })).toBeNull();
    expect(directorySource({ kind: 'memory', name: 'm', files: {} })).toBeNull();
  });
});

describe('model file', () => {
  it('round-trips a model through export and import', async () => {
    const model = syntheticModel(60);
    const file = await exportModelFile(model);
    expect(modelFileName(model)).toBe(`${model.meta.name}.starmap.json.gz`);
    const back = await importModelFile(file);
    expect(back.meta.source).toBe('import');
    expect(back.tables).toEqual(model.tables);
    await expect(importModelFile(new Blob(['not a map']))).rejects.toThrow(/Not a starmap file/);
  });
});
