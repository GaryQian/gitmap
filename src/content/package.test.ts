// The package file (plan/DEMO-MODE.md §2, §4). What is pinned: a written package reads back whole and
// verified; what the writer leaves out and why; the map is in hand after the front of one download
// while the files are still arriving; and a kept copy opens without a download.
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decodeModel, type RepoModel } from '../model';
import { gitBlobOid } from '../shared';
import { syntheticMeta } from '../testing/synthetic';
import {
  detectLicense, findZipEnd, licenseOf, memorySink, openPackage, packageFileName, packOrder, parseZipDirectory, readPackage,
  sourceUrlOf, writePackage, FILES_PREFIX, MANIFEST_ENTRY, MAP_ENTRY, NotInPackageError, PackageFormatError,
  PackageMismatchError, PACKAGE_FORMAT, ZIP_END_MAX,
  type PackageCache, type WritePackageOptions, type ZipEntry,
} from './index';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Source-like text, which deflates well. */
const code = (name: string, lines: number): string =>
  Array.from({ length: lines }, (_, i) => `export const ${name}${i} = ${i}; // ${name}\n`).join('');

/** Text that hardly deflates, so an entry's size in the archive follows its length. */
function noise(bytes: number, seed: number): string {
  let s = seed >>> 0, out = '';
  while (out.length < bytes) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out += s.toString(36) + (out.length % 80 > 70 ? '\n' : '');
  }
  return out.slice(0, bytes - 1) + '\n';
}

interface FileSpec {
  /** What the map was built from. */
  text: string | Uint8Array;
  /** The unit's importance percentile; absent: the file belongs to no unit. */
  importance?: number;
  loc?: number;
  /** False: the map recorded no blob id for the file. */
  oid?: boolean;
}

const bytesOfSpec = (spec: FileSpec): Uint8Array => (typeof spec.text === 'string' ? enc.encode(spec.text) : spec.text);

/** A model with one unit per file (for those that have an importance) and two contributors. */
async function modelOf(specs: Record<string, FileSpec>, name = 'pkg'): Promise<RepoModel> {
  const paths = Object.keys(specs);
  const inUnit = paths.filter((p) => specs[p].importance !== undefined);
  const locOf = (p: string): number => specs[p].loc ?? dec.decode(bytesOfSpec(specs[p])).split('\n').length - 1;
  const oids: string[] = [];
  for (const p of paths) oids.push(specs[p].oid === false ? '' : await gitBlobOid(bytesOfSpec(specs[p])));
  return {
    schema: 1,
    meta: {
      ...syntheticMeta(name), headOid: 'c0ffee'.padEnd(40, '0'), parserVersion: '7',
      history: { reachedOid: null, commitsWalked: 3, complete: true },
    },
    tables: {
      city: { ids: ['c1'], cols: { name: ['City'] } },
      district: { ids: ['d1'], cols: { city: ['c1'], name: ['District'] } },
      unit: {
        ids: inUnit,
        cols: {
          primaryFile: inUnit, fileCount: inUnit.map(() => 1), loc: inUnit.map(locOf), bytes: inUnit.map((p) => bytesOfSpec(specs[p]).length),
          lang: inUnit.map(() => 'ts'), importancePct: inUnit.map((p) => specs[p].importance!), fanIn: inUnit.map(() => 0),
          fanOut: inUnit.map(() => 0), district: inUnit.map(() => 'd1'),
        },
      },
      file: {
        ids: paths,
        cols: {
          lang: paths.map(() => 'ts'), bytes: paths.map((p) => bytesOfSpec(specs[p]).length), loc: paths.map(locOf), oid: oids,
          unit: paths.map((p) => (specs[p].importance !== undefined ? p : '')),
        },
      },
      edge: { ids: [], cols: { src: [], dst: [], kind: [], weight: [], confidence: [], mechanism: [], symbols: [] } },
      contributor: {
        ids: ['0', '1'],
        cols: { name: ['Ada Lovelace', 'Grace Hopper'], emails: ['ada@example.com,ada@old.example.com', 'grace@example.com'], commits: [5, 2] },
      },
    },
    layers: {},
    annotations: { pois: [], tours: [], summaries: [] },
  };
}

/** The `read` writePackage takes, over what is "on disk" now; it notes the batches it was asked for. */
function diskOf(files: Record<string, Uint8Array | string>): { read: WritePackageOptions['read']; batches: string[][] } {
  const batches: string[][] = [];
  return {
    batches,
    read: async (paths) => {
      batches.push(paths);
      return paths.map((p) => (p in files ? (typeof files[p] === 'string' ? enc.encode(files[p] as string) : (files[p] as Uint8Array)) : null));
    },
  };
}

const oidLookup = (model: RepoModel) => (path: string): string | null => {
  const row = model.tables.file.ids.indexOf(path);
  return row < 0 ? null : model.tables.file.cols.oid![row] || null;
};

async function entriesOf(zip: Uint8Array): Promise<ZipEntry[]> {
  const end = findZipEnd(zip.subarray(Math.max(0, zip.length - ZIP_END_MAX)));
  return parseZipDirectory(zip.subarray(end.cdOffset, end.cdOffset + end.cdSize), end).sort((a, b) => a.offset - b.offset);
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const INFO = { sourceUrl: 'https://example.com/acme/pkg', license: 'MIT', ai: 'none' } as const;
const MIT = 'MIT License\n\nCopyright (c) someone\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n';

/** A small repo: three files on the map and a licence beside them. */
const REPO: Record<string, FileSpec> = {
  'src/app/main.ts': { text: code('main', 400), importance: 0.4 },
  'src/lib/útil.ts': { text: code('util', 900), importance: 0.9 }, // a non-ASCII name
  'docs/notes.md': { text: '# Notes\n\nShort.\n', importance: 0.1 },
  'empty.txt': { text: '', importance: 0.05 },
};

async function repoPackage(opts: Partial<WritePackageOptions> = {}) {
  const model = await modelOf(REPO);
  const disk: Record<string, Uint8Array | string> = { LICENSE: MIT };
  for (const [p, spec] of Object.entries(REPO)) disk[p] = bytesOfSpec(spec);
  const sink = memorySink();
  const report = await writePackage({ model, info: INFO, read: diskOf(disk).read, sink, ...opts });
  const zip = new Uint8Array(await sink.blob().arrayBuffer());
  return { model, report, blob: sink.blob(), zip };
}

describe('writePackage → readPackage', () => {
  it('round-trips the map and every file, verified against the map, and strips e-mails from the copy only', async () => {
    const { model, report, blob, zip } = await repoPackage();
    expect(report).toMatchObject({ bytes: blob.size, packedFiles: 4, trimmedFiles: 0, unreadableFiles: 0, skippedFiles: 0 });
    expect(report.rawBytes).toBe(Object.values(REPO).reduce((n, s) => n + bytesOfSpec(s).length, 0));

    // the layout the streaming reader depends on: manifest, map (stored), licence, then files by importance
    const entries = await entriesOf(zip);
    expect(entries.map((e) => e.path)).toEqual([
      MANIFEST_ENTRY, MAP_ENTRY, 'files/LICENSE', 'files/src/lib/útil.ts', 'files/src/app/main.ts', 'files/docs/notes.md', 'files/empty.txt',
    ]);
    expect(entries[1].method).toBe(0);
    expect(entries[3].method).toBe(8);
    expect(entries[3].compressedSize).toBeLessThan(entries[3].size / 2);
    // a plain zip: another reader opens it too
    expect(unzipSync(zip)['files/src/lib/útil.ts']).toEqual(bytesOfSpec(REPO['src/lib/útil.ts']));

    const opened = await readPackage(blob, { oidOf: oidLookup(model) });
    expect(opened.manifest).toMatchObject({
      format: PACKAGE_FORMAT, name: 'pkg', sourceUrl: INFO.sourceUrl, license: 'MIT', ai: 'none', commit: model.meta.headOid,
      parserVersion: '7', files: 4, structure: 'full', historyComplete: true, maxBytes: 0, minLines: 0,
    });
    expect(opened.manifest).toEqual(report.manifest);
    expect(Math.abs(opened.manifest.exportedAt - Date.now())).toBeLessThan(60_000);

    const back = await decodeModel(opened.map);
    expect(back.tables.contributor.cols).toEqual({ name: ['Ada Lovelace', 'Grace Hopper'], emails: ['', ''], commits: [5, 2] });
    expect(dec.decode(await gunzip(opened.map))).not.toContain('example.com'); // nowhere else in the file either
    expect(model.tables.contributor.cols.emails).toEqual(['ada@example.com,ada@old.example.com', 'grace@example.com']); // the caller's model is untouched
    expect({ ...back.tables, contributor: null }).toEqual({ ...model.tables, contributor: null });

    await opened.content.ready;
    expect(opened.content.progress().done).toBe(true);
    for (const [path, spec] of Object.entries(REPO)) {
      expect(opened.content.has(path)).toBe(true);
      expect(await opened.content.read(`f:${path}`)).toEqual(bytesOfSpec(spec));
    }
    expect(await opened.content.read('u:src/lib/útil.ts')).toEqual(bytesOfSpec(REPO['src/lib/útil.ts'])); // a unit's primary file
    expect(dec.decode(await opened.content.read('f:LICENSE'))).toBe(MIT); // not on the map: served unverified
    expect(opened.content.has('src/gone.ts')).toBe(false);
    await expect(opened.content.read('f:src/gone.ts')).rejects.toBeInstanceOf(NotInPackageError);
    await expect(opened.content.read('d:some-district')).rejects.toThrow(/Only a file/);

    // the reader checks too: a map that recorded another version of a file refuses the one in the package
    const other = await gitBlobOid(enc.encode('another version\n'));
    const strict = await readPackage(blob, { oidOf: (p) => (p === 'docs/notes.md' ? other : null) });
    await expect(strict.content.read('f:docs/notes.md')).rejects.toBeInstanceOf(PackageMismatchError);
    expect(packageFileName(model)).toBe('pkg.starmap.zip');
  });

  it('packs most important first, larger first among equals, and leaves out files under the line floor', async () => {
    const model = await modelOf({
      'b.ts': { text: 'x\n', importance: 0.5, loc: 10 },
      'a.ts': { text: 'x\n', importance: 0.5, loc: 10 },
      'big.ts': { text: 'x\n', importance: 0.5, loc: 300 },
      'top.ts': { text: 'x\n', importance: 0.99, loc: 3 },
      'loose.txt': { text: 'x\n', loc: 5000 }, // in no unit: counts as importance 0
      'tiny.ts': { text: 'x\n', importance: 0.7, loc: 1 },
    });
    expect(packOrder(model)).toEqual({ paths: ['top.ts', 'tiny.ts', 'big.ts', 'a.ts', 'b.ts', 'loose.txt'], trimmed: 0 });
    expect(packOrder(model, { minLines: 4 })).toEqual({ paths: ['big.ts', 'a.ts', 'b.ts', 'loose.txt'], trimmed: 2 });

    const disk = diskOf({ 'a.ts': 'x\n', 'b.ts': 'x\n', 'big.ts': 'x\n', 'top.ts': 'x\n', 'loose.txt': 'x\n', 'tiny.ts': 'x\n' });
    const sink = memorySink();
    const report = await writePackage({ model, info: INFO, read: disk.read, sink, minLines: 4, extras: [] });
    expect(report).toMatchObject({ packedFiles: 4, trimmedFiles: 2 });
    expect(report.manifest).toMatchObject({ minLines: 4, files: 6 });
    expect(disk.batches).toEqual([['big.ts', 'a.ts', 'b.ts', 'loose.txt']]);
  });

  it('keeps the archive under the budget, trimming what does not fit and carrying on with smaller files', async () => {
    const specs: Record<string, FileSpec> = {
      'first.ts': { text: noise(4000, 1), importance: 0.9 },
      'huge.ts': { text: noise(40_000, 2), importance: 0.8 },
      'small.ts': { text: noise(3000, 3), importance: 0.2 },
    };
    const model = await modelOf(specs);
    const disk: Record<string, Uint8Array> = {};
    for (const [p, s] of Object.entries(specs)) disk[p] = bytesOfSpec(s);
    const whole = memorySink();
    const all = await writePackage({ model, info: INFO, read: diskOf(disk).read, sink: whole, extras: [] });
    expect(all.packedFiles).toBe(3);
    const huge = (await entriesOf(new Uint8Array(await whole.blob().arrayBuffer()))).find((e) => e.path === 'files/huge.ts')!;
    expect(huge.compressedSize).toBeGreaterThan(20_000);

    // room for everything but the huge file
    const maxBytes = all.bytes - huge.compressedSize;
    const sink = memorySink();
    const progress: number[][] = [];
    const report = await writePackage({
      model, info: INFO, read: diskOf(disk).read, sink, maxBytes, extras: [], onProgress: (...args) => progress.push(args),
    });
    expect(report).toMatchObject({ packedFiles: 2, trimmedFiles: 1, unreadableFiles: 0, bytes: sink.blob().size });
    expect(report.rawBytes).toBe(7000);
    expect(sink.blob().size).toBeLessThanOrEqual(maxBytes);
    expect(progress.at(-1)!.slice(0, 2)).toEqual([3, 3]);
    const opened = await readPackage(sink.blob(), { oidOf: oidLookup(model) });
    expect(opened.manifest.maxBytes).toBe(maxBytes);
    expect(await opened.content.read('f:small.ts')).toEqual(disk['small.ts']);
    expect(opened.content.has('huge.ts')).toBe(false);
    await expect(opened.content.read('f:huge.ts')).rejects.toBeInstanceOf(NotInPackageError); // still on the map

    // no room at all: nothing is even read
    const none = diskOf(disk);
    const tight = memorySink();
    const nothing = await writePackage({ model, info: INFO, read: none.read, sink: tight, maxBytes: 300, extras: [] });
    expect(nothing).toMatchObject({ packedFiles: 0, trimmedFiles: 3 });
    expect(none.batches).toEqual([]);
    expect((await readPackage(tight.blob(), { oidOf: oidLookup(model) })).manifest.name).toBe('pkg'); // still a package
  });

  it('normalises a CRLF checkout, and leaves out files that changed, cannot be read, are binary or too long', async () => {
    const lf = code('crlf', 40);
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 0]);
    const model = await modelOf({
      'crlf.ts': { text: lf, importance: 0.9 },
      'edited.ts': { text: code('edited', 20), importance: 0.8 },
      'gone.ts': { text: code('gone', 20), importance: 0.7 },
      'image.png': { text: binary, importance: 0.6 },
      'long.ts': { text: code('long', 200), importance: 0.5 },
      'untracked.ts': { text: 'as parsed\n', importance: 0.4, oid: false },
    });
    const disk = diskOf({
      'crlf.ts': lf.replace(/\n/g, '\r\n'),
      'edited.ts': code('edited', 20) + '// changed since the parse\n',
      'image.png': binary,
      'long.ts': code('long', 200),
      'untracked.ts': 'whatever is there now\r\n', // no blob id to hold it to: packed as it is
      'NOTICE': 'Notice.\n',
    });
    const sink = memorySink();
    const report = await writePackage({ model, info: INFO, read: disk.read, sink, maxFileBytes: 2000 });
    expect(report).toMatchObject({ packedFiles: 2, unreadableFiles: 2, skippedFiles: 2, trimmedFiles: 0 });

    const opened = await readPackage(sink.blob(), { oidOf: oidLookup(model) });
    expect(dec.decode(await opened.content.read('f:crlf.ts'))).toBe(lf); // the bytes the map's blob id is of
    expect(dec.decode(await opened.content.read('f:untracked.ts'))).toBe('whatever is there now\r\n');
    expect(dec.decode(await opened.content.read('f:NOTICE'))).toBe('Notice.\n');
    for (const left of ['edited.ts', 'gone.ts', 'image.png', 'long.ts']) expect(opened.content.has(left)).toBe(false);
  });

  it('aborts the sink and rejects with AbortError when cancelled', async () => {
    const model = await modelOf(REPO);
    const stop = new AbortController();
    const sink = memorySink();
    let aborted = 0;
    const failed = await writePackage({
      model, info: INFO, signal: stop.signal, extras: [],
      sink: { ...sink, abort: () => { aborted++; } },
      read: async (paths) => { stop.abort(); return paths.map(() => enc.encode('x\n')); },
    }).then(() => null, (err: unknown) => err);
    expect((failed as Error).name).toBe('AbortError');
    expect(aborted).toBe(1);
  });

  it('says so when a file is not a package, or needs a newer app', async () => {
    const zipOf = (input: Zippable): Blob => new Blob([zipSync(input) as Uint8Array<ArrayBuffer>]);
    const manifest = (format: number): Uint8Array => enc.encode(JSON.stringify({ format, name: 'x' }));
    const opts = { oidOf: () => null };
    await expect(readPackage(new Blob(['just some text, not a zip archive']), opts)).rejects.toBeInstanceOf(PackageFormatError);
    await expect(readPackage(zipOf({ 'readme.txt': enc.encode('hi') }), opts)).rejects.toThrow(/not a Starmap package/);
    await expect(readPackage(zipOf({ [MANIFEST_ENTRY]: enc.encode('{ nope') }), opts)).rejects.toBeInstanceOf(PackageFormatError);
    const newer = zipOf({ [MANIFEST_ENTRY]: manifest(PACKAGE_FORMAT + 1), [MAP_ENTRY]: enc.encode('{}') });
    await expect(readPackage(newer, opts)).rejects.toThrow('This package was written by a newer version of the app.');
    // by URL the manifest is the first thing to arrive, and is enough to refuse
    const host = fakeHost(new Uint8Array(await newer.arrayBuffer()));
    const err = await openPackage(URL_, { ...opts, fetch: host.fetch, cache: null }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PackageFormatError);
    expect((err as Error).message).toMatch(/newer version/);
  });
});

// ---- by URL ----

const URL_ = 'https://demo.example/demo/pkg.starmap.zip';

/** A response body that delivers the archive in small chunks, as far as it is told to. */
function heldBody(bytes: Uint8Array, chunk = 997) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  let sent = 0;
  return {
    stream,
    get sent() { return sent; },
    deliver(to: number): void {
      while (sent < to) {
        const n = Math.min(chunk, to - sent);
        controller.enqueue(bytes.slice(sent, sent + n));
        sent += n;
      }
      if (sent === bytes.length) controller.close();
    },
    fail(): void { controller.error(new TypeError('network error')); },
  };
}

/** A static host for one file. With `hold` set a GET's body waits to be delivered by the test. */
function fakeHost(zip: Uint8Array) {
  const host = {
    requests: [] as string[],
    bodies: [] as ReturnType<typeof heldBody>[],
    hold: false,
    offline: false,
    etag: '"v1"',
    fetch: (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET';
      host.requests.push(method);
      if (host.offline) throw new TypeError('offline');
      const headers = { 'Content-Length': String(zip.length), ETag: host.etag };
      if (method === 'HEAD') return new Response(null, { headers });
      const body = heldBody(zip);
      host.bodies.push(body);
      if (!host.hold) body.deliver(zip.length);
      return new Response(body.stream, { headers });
    }) as typeof fetch,
  };
  return host;
}

function memoryCache(): PackageCache & { store: Map<string, { blob: Blob; headers: [string, string][] }> } {
  const store = new Map<string, { blob: Blob; headers: [string, string][] }>();
  return {
    store,
    async match(url) { const hit = store.get(url); return hit ? new Response(hit.blob, { headers: hit.headers }) : undefined; },
    async put(url, res) { store.set(url, { blob: await res.blob(), headers: [...res.headers] }); },
    async delete(url) { return store.delete(url); },
  };
}

/** Whether a promise settles within a moment (used only to show that one has NOT). */
const settles = (p: Promise<unknown>, ms = 40): Promise<boolean> =>
  Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  if (!cond()) throw new Error('the condition never came true');
}

describe('openPackage', () => {
  it('has the map after the front of the download, serves files once the rest is in, and reopens from the kept copy', async () => {
    const { model, zip } = await repoPackage();
    const mapEnd = (await entriesOf(zip))[1].end;
    expect(mapEnd).toBeLessThan(zip.length - 2000);
    const host = fakeHost(zip);
    host.hold = true;
    const cache = memoryCache();
    const seen: [number, number | null][] = [];
    const opts = { oidOf: oidLookup(model), fetch: host.fetch, cache, onProgress: (loaded: number, total: number | null) => { seen.push([loaded, total]); } };

    const opening = openPackage(URL_, opts);
    await until(() => host.bodies.length === 1);
    const body = host.bodies[0];
    body.deliver(mapEnd - 1);
    expect(await settles(opening)).toBe(false); // one byte short of the map
    body.deliver(mapEnd);
    const opened = await opening;
    expect(body.sent).toBe(mapEnd); // nothing of the files has been delivered
    expect(opened.manifest.name).toBe('pkg');
    expect((await decodeModel(opened.map)).tables.file.ids).toEqual(model.tables.file.ids);
    expect(seen.at(-1)).toEqual([mapEnd, zip.length]);
    expect(opened.content.has('src/app/main.ts')).toBeNull();
    expect(opened.content.progress()).toEqual({ loaded: mapEnd, total: zip.length, done: false });

    const reading = opened.content.read('f:src/app/main.ts');
    expect(await settles(reading)).toBe(false); // waits for the files
    body.deliver(zip.length);
    expect(await reading).toEqual(bytesOfSpec(REPO['src/app/main.ts']));
    await opened.content.ready;
    expect(opened.content.progress()).toEqual({ loaded: zip.length, total: zip.length, done: true });
    expect(opened.content.has('src/app/main.ts')).toBe(true);
    expect(opened.content.has('src/gone.ts')).toBe(false);
    await expect(opened.content.read('f:src/gone.ts')).rejects.toBeInstanceOf(NotInPackageError);
    expect(seen.at(-1)).toEqual([mapEnd, zip.length]); // the waiting screen's line stops at the map
    await until(() => cache.store.size === 1);
    expect(host.requests).toEqual(['GET']);

    // next visit: the host is asked whether it changed, and nothing is downloaded
    host.hold = false;
    const again = await openPackage(URL_, opts);
    expect(host.requests).toEqual(['GET', 'HEAD']);
    expect(again.content.progress().done).toBe(true);
    expect(again.manifest).toEqual(opened.manifest);
    expect(await again.content.read('u:src/lib/útil.ts')).toEqual(bytesOfSpec(REPO['src/lib/útil.ts']));

    // offline: the kept copy is used as it is
    host.offline = true;
    const offline = await openPackage(URL_, opts);
    expect(await offline.content.read('f:docs/notes.md')).toEqual(bytesOfSpec(REPO['docs/notes.md']));
    expect(host.requests).toEqual(['GET', 'HEAD', 'HEAD']);

    // a rebuilt package on the host replaces the kept one
    host.offline = false;
    host.etag = '"v2"';
    const rebuilt = await openPackage(URL_, opts);
    await rebuilt.content.ready;
    expect(host.requests).toEqual(['GET', 'HEAD', 'HEAD', 'HEAD', 'GET']);
    await until(() => cache.store.get(URL_)?.headers.some(([, v]) => v === '"v2"') === true);
  });

  it('opens an archive another tool wrote, once all of it is in', async () => {
    const { model, blob } = await repoPackage();
    const own = await readPackage(blob, { oidOf: oidLookup(model) });
    // the same package, zipped again with its entries in another order
    const input: Zippable = {};
    for (const path of Object.keys(REPO)) input[FILES_PREFIX + path] = await own.content.read(`f:${path}`);
    input[MAP_ENTRY] = [own.map, { level: 0 }];
    input[MANIFEST_ENTRY] = enc.encode(JSON.stringify(own.manifest));
    const zip = zipSync(input);
    expect((await entriesOf(zip))[0].path).not.toBe(MANIFEST_ENTRY);

    const host = fakeHost(zip);
    host.hold = true;
    const opening = openPackage(URL_, { oidOf: oidLookup(model), fetch: host.fetch, cache: null });
    await until(() => host.bodies.length === 1);
    host.bodies[0].deliver(zip.length - 1);
    expect(await settles(opening)).toBe(false);
    host.bodies[0].deliver(zip.length);
    const opened = await opening;
    expect(opened.manifest).toEqual(own.manifest);
    expect(opened.map).toEqual(own.map);
    expect(opened.content.progress().done).toBe(true);
    expect(await opened.content.read('f:src/lib/útil.ts')).toEqual(bytesOfSpec(REPO['src/lib/útil.ts']));
  });

  it('fails the waiting reads when the download breaks after the map, and the next read downloads again', async () => {
    const { model, zip } = await repoPackage();
    const mapEnd = (await entriesOf(zip))[1].end;
    const host = fakeHost(zip);
    host.hold = true;
    const opening = openPackage(URL_, { oidOf: oidLookup(model), fetch: host.fetch, cache: null });
    await until(() => host.bodies.length === 1);
    host.bodies[0].deliver(mapEnd + 500);
    const opened = await opening;
    const waiting = opened.content.read('f:src/app/main.ts').then(() => null, (e: Error) => e);
    const firstReady = opened.content.ready.then(() => null, (e: Error) => e);
    host.bodies[0].fail();
    expect((await waiting)!.message).toBe("The demo's files could not be downloaded. Check the connection and open the file again.");
    expect((await firstReady)!.message).toMatch(/could not be downloaded/);
    expect(opened.content.has('src/app/main.ts')).toBeNull();

    host.hold = false;
    expect(await opened.content.read('f:src/app/main.ts')).toEqual(bytesOfSpec(REPO['src/app/main.ts']));
    expect(await opened.content.read('f:docs/notes.md')).toEqual(bytesOfSpec(REPO['docs/notes.md']));
    expect(host.requests).toEqual(['GET', 'GET']); // one more download, shared
    await opened.content.ready;
    expect(opened.content.progress().done).toBe(true);

    // before the map there is nothing to show: the open itself fails
    const dead = fakeHost(zip);
    dead.offline = true;
    await expect(openPackage(URL_, { oidOf: oidLookup(model), fetch: dead.fetch, cache: null })).rejects.toThrow(/could not be downloaded/);
  });
});

describe('sourceUrlOf', () => {
  it('turns a remote into the https address of the repo', () => {
    expect(sourceUrlOf('git@github.com:a/b.git')).toBe('https://github.com/a/b');
    expect(sourceUrlOf('ssh://git@host.example:2222/a/b.git')).toBe('https://host.example/a/b');
    expect(sourceUrlOf('https://user:pw@host.example/a/b.git/')).toBe('https://host.example/a/b');
    expect(sourceUrlOf('http://host.example:8080/a/b')).toBe('http://host.example:8080/a/b');
    expect(sourceUrlOf('github.com/facebook/react')).toBe('https://github.com/facebook/react'); // as the model keeps it
    for (const none of [null, undefined, '', '  ', '/srv/git/a', 'C:/Users/me/a', 'C:\\Users\\me\\a', '../a', 'file:///srv/a', 'a/b']) {
      expect(sourceUrlOf(none)).toBe('');
    }
  });
});

describe('licence', () => {
  it('recognises a licence text, and prefers LICENSE over the other root files', async () => {
    expect(detectLicense(MIT)).toBe('MIT');
    expect(detectLicense('Copyright (c) someone\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and so on.\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED\n')).toBe('MIT');
    expect(detectLicense('\n                                 Apache License\n                           Version 2.0, January 2004\n')).toBe('Apache-2.0');
    expect(detectLicense('All rights reserved.\n')).toBe('unknown');

    const apache = 'Apache License\nVersion 2.0, January 2004\n';
    expect(await licenseOf(diskOf({ COPYING: apache, LICENSE: MIT }).read)).toBe('MIT');
    expect(await licenseOf(diskOf({ 'COPYING.txt': apache, 'LICENSE.md': 'All rights reserved.\n' }).read)).toBe('Apache-2.0');
    expect(await licenseOf(diskOf({ AUTHORS: 'Ada\n' }).read)).toBe('unknown');
  });
});
