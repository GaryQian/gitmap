// The object store below the repo API: SHA-1, deltas, the pack index, paged reads, loose objects and
// the caches. Where git can be asked it is the oracle; elsewhere the object id is (an object's id is
// the SHA-1 of its content, so a wrong byte anywhere cannot pass).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildFixtureRepo, git, projectRoot } from '../testing/fixture';
import { MemoryGitFs } from '../testing/memory';
import {
  applyDelta, hashObject, hexToBytes, isOid, openGitRepo, PackIndex, PageCache, PagedFile, sha1, toHex,
  type GitRepository, type GitRepoOptions,
} from './index';
import { NodeGitFs, NodeWorkingTree } from './node';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

describe('bytes', () => {
  it('sha1 equals node:crypto for any input, including the padding boundaries', () => {
    const reference = (b: Uint8Array): string => createHash('sha1').update(b).digest('hex');
    for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 70000]) {
      const b = new Uint8Array(n).map((_, i) => (i * 131 + n) & 255);
      expect(toHex(sha1(b)), `length ${n}`).toBe(reference(b));
    }
    fc.assert(fc.property(fc.uint8Array({ maxLength: 400 }), (b) => toHex(sha1(b)) === reference(b)), { numRuns: 200 });
    // a view into a larger buffer hashes only its own bytes
    const big = new Uint8Array(300).fill(7);
    expect(toHex(sha1(big.subarray(10, 110)))).toBe(reference(new Uint8Array(100).fill(7)));
  });

  it('hex helpers round-trip, and isOid accepts only a full lower-case SHA-1', () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 20, maxLength: 20 }), (b) => {
      const hex = toHex(b);
      return isOid(hex) && toHex(hexToBytes(hex)) === hex && toHex(hexToBytes(hex.toUpperCase())) === hex;
    }), { numRuns: 100 });
    for (const bad of ['', 'abc', 'g'.repeat(40), 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(64)]) expect(isOid(bad), bad).toBe(false);
  });

  it('hashObject gives every tracked file of the fixture the id git recorded for it', () => {
    const dir = buildFixtureRepo('three-lang');
    const fs = new NodeGitFs(path.join(dir, '.git'));
    const entries = openGitRepo(fs).indexEntries();
    fs.close();
    expect(entries.length).toBeGreaterThan(10);
    for (const e of entries) expect(hashObject('blob', new Uint8Array(readFileSync(path.join(dir, e.path)))), e.path).toBe(e.oid);
  });
});

// --- deltas ---------------------------------------------------------------------------------------
function varint(n: number): number[] {
  const out: number[] = [];
  do {
    const b = n & 127;
    n = Math.floor(n / 128);
    out.push(n > 0 ? b | 128 : b);
  } while (n > 0);
  return out;
}
type DeltaOp = { copy: [off: number, len: number] } | { insert: Uint8Array };
/** Encode a delta the way git does: base size, result size, then copy and insert instructions. */
function encodeDelta(baseLen: number, ops: DeltaOp[], resultLen?: number): Uint8Array {
  const body: number[] = [];
  let produced = 0;
  for (const op of ops) {
    if ('insert' in op) {
      body.push(op.insert.length, ...op.insert);
      produced += op.insert.length;
      continue;
    }
    const [off, len] = op.copy;
    const size = len === 0x10000 ? 0 : len; // a size of 0 means 64 KiB
    let head = 0x80;
    const args: number[] = [];
    for (let i = 0; i < 4; i++) { const b = (off >>> (8 * i)) & 255; if (b) { head |= 1 << i; args.push(b); } }
    for (let i = 0; i < 3; i++) { const b = (size >>> (8 * i)) & 255; if (b) { head |= 16 << i; args.push(b); } }
    body.push(head, ...args);
    produced += len;
  }
  return new Uint8Array([...varint(baseLen), ...varint(resultLen ?? produced), ...body]);
}

describe('applyDelta', () => {
  it('any sequence of copies and inserts produces the bytes it describes', () => {
    const opArb = (baseLen: number): fc.Arbitrary<DeltaOp> => {
      const insert = fc.uint8Array({ minLength: 1, maxLength: 127 }).map((b) => ({ insert: b }));
      if (baseLen === 0) return insert;
      const copy = fc.nat(baseLen - 1).chain((off) => fc.integer({ min: 1, max: baseLen - off }).map((len) => ({ copy: [off, len] as [number, number] })));
      return fc.oneof(insert, copy);
    };
    const caseArb = fc.uint8Array({ maxLength: 600 }).chain((base) => fc.tuple(fc.constant(base), fc.array(opArb(base.length), { maxLength: 12 })));
    fc.assert(fc.property(caseArb, ([base, ops]) => {
      const expected = concat(ops.map((op) => ('insert' in op ? op.insert : base.subarray(op.copy[0], op.copy[0] + op.copy[1]))));
      expect(applyDelta(base, encodeDelta(base.length, ops))).toEqual(expected);
    }), { numRuns: 300 });
  });

  it('large copies: offsets past 16 MiB of a base and the 64 KiB size that is encoded as zero', () => {
    const base = new Uint8Array(0x1010000 + 5).map((_, i) => (i * 7 + (i >>> 16)) & 255);
    const ops: DeltaOp[] = [{ copy: [0x1000003, 0x10000] }, { insert: enc('mid') }, { copy: [0x0100ff, 0x1234] }, { copy: [0, 1] }];
    const out = applyDelta(base, encodeDelta(base.length, ops));
    expect(out.length).toBe(0x10000 + 3 + 0x1234 + 1);
    expect(Buffer.from(out).equals(Buffer.from(concat([base.subarray(0x1000003, 0x1010003), enc('mid'), base.subarray(0x0100ff, 0x0100ff + 0x1234), base.subarray(0, 1)])))).toBe(true);
  });

  it('a delta that does not fit its base or its stated size is an error, not a wrong object', () => {
    const base = enc('0123456789');
    expect(() => applyDelta(enc('01234'), encodeDelta(10, [{ copy: [0, 5] }]))).toThrow(/base size/);
    expect(() => applyDelta(base, encodeDelta(10, [{ copy: [8, 5] }]))).toThrow(/out of range/);
    expect(() => applyDelta(base, encodeDelta(10, [{ copy: [0, 5] }], 4))).toThrow(/out of range/);
    expect(() => applyDelta(base, encodeDelta(10, [{ insert: enc('abc') }], 2))).toThrow(/out of range/);
    expect(() => applyDelta(base, encodeDelta(10, [{ copy: [0, 5] }], 9))).toThrow(/size mismatch/);
    expect(() => applyDelta(base, new Uint8Array([...varint(10), ...varint(1), 0]))).toThrow(/opcode 0/);
    expect(applyDelta(base, encodeDelta(10, []))).toEqual(new Uint8Array(0));
  });
});

// --- paged reads and the pack index ---------------------------------------------------------------
describe('PagedFile', () => {
  it('any read through any page size equals the bytes of the file; two files share a cache without mixing', () => {
    const readArb = (size: number): fc.Arbitrary<[number, number]> =>
      fc.nat(size - 1).chain((off) => fc.integer({ min: 1, max: size - off }).map((len) => [off, len] as [number, number]));
    const caseArb = fc.integer({ min: 1, max: 3000 }).chain((size) => fc.record({
      size: fc.constant(size),
      pageBytes: fc.integer({ min: 0, max: 700 }),
      budget: fc.integer({ min: 0, max: 4000 }),
      reads: fc.array(fc.tuple(fc.boolean(), readArb(size)), { minLength: 1, maxLength: 40 }),
    }));
    fc.assert(fc.property(caseArb, ({ size, pageBytes, budget, reads }) => {
      const a = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 255);
      const b = new Uint8Array(size).map((_, i) => (i * 17 + 201) & 255);
      const fs = new MemoryGitFs({ a, b });
      const cache = new PageCache(pageBytes, budget);
      const io = { calls: 0, bytes: 0 };
      const files = [new PagedFile(fs, 'a', size, cache, 0, io), new PagedFile(fs, 'b', size, cache, 1, io)];
      for (const [second, [off, len]] of reads) {
        const got = files[second ? 1 : 0].read(off, len);
        expect(Buffer.from(got).equals(Buffer.from((second ? b : a).subarray(off, off + len)))).toBe(true);
      }
    }), { numRuns: 200 });
  });

  it('small reads inside one page cost one underlying read', () => {
    const bytes = new Uint8Array(4096).map((_, i) => i & 255);
    const io = { calls: 0, bytes: 0 };
    const file = new PagedFile(new MemoryGitFs({ f: bytes }), 'f', bytes.length, new PageCache(1024, 1 << 20), 0, io);
    for (let i = 0; i < 50; i++) file.read((i * 13) % 1000, 20);
    expect(io.calls).toBe(1);
  });
});

/** A hand-built .idx (version 2) for [oid, offset] rows; offsets of 2^31 or more go to the 64-bit table. */
function buildIdx(rows: [string, number][]): Uint8Array {
  const sorted = [...rows].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const n = sorted.length;
  const large = sorted.filter((r) => r[1] >= 0x80000000);
  const buf = new Uint8Array(8 + 1024 + n * 28 + large.length * 8 + 40);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0xff744f63);
  dv.setUint32(4, 2);
  for (let b = 0; b < 256; b++) dv.setUint32(8 + b * 4, sorted.filter((r) => parseInt(r[0].slice(0, 2), 16) <= b).length);
  const oidAt = 8 + 1024, off32At = oidAt + n * 24, off64At = off32At + n * 4;
  sorted.forEach(([oid, offset], i) => {
    buf.set(hexToBytes(oid), oidAt + i * 20);
    const k = large.findIndex((r) => r[0] === oid);
    if (k < 0) dv.setUint32(off32At + i * 4, offset);
    else {
      dv.setUint32(off32At + i * 4, (0x80000000 | k) >>> 0);
      dv.setUint32(off64At + k * 8, Math.floor(offset / 4294967296));
      dv.setUint32(off64At + k * 8 + 4, offset >>> 0);
    }
  });
  return buf;
}

describe('PackIndex', () => {
  it('finds every id, misses near neighbours, and reads offsets past 4 GiB from the 64-bit table', () => {
    const oid = (first: string, fill: string, last: string): string => first + fill.repeat(36) + last;
    const packSize = 6 * 4294967296;
    const rows: [string, number][] = [
      [oid('00', '0', '01'), 12], [oid('00', '0', '02'), 5 * 4294967296 + 77], [oid('00', 'f', 'ff'), 4000],
      [oid('7a', '1', '10'), 0x7fffffff], [oid('7a', '1', '11'), 0x80000000], [oid('ff', 'f', 'fe'), 300], [oid('ff', 'f', 'ff'), 4294967296 + 1],
    ];
    const idx = new PackIndex(buildIdx(rows), packSize);
    expect(idx.n).toBe(rows.length);
    for (const [id, offset] of rows) expect(idx.find(hexToBytes(id)), id).toBe(offset);
    for (const missing of [oid('00', '0', '00'), oid('00', '0', '03'), oid('01', '0', '01'), oid('7a', '1', '12'), oid('fe', 'f', 'ff'), oid('80', '0', '00')]) {
      expect(idx.find(hexToBytes(missing)), missing).toBe(-1);
    }
    // an id found inside a larger buffer, as tree entries and commit parents are
    const framed = concat([new Uint8Array(7), hexToBytes(rows[3][0]), new Uint8Array(3)]);
    expect(idx.find(framed, 7)).toBe(rows[3][1]);
    // each object ends where the next one in the pack starts; the last ends at the 20-byte trailer
    const byOffset = rows.map((r) => r[1]).sort((x, y) => x - y);
    byOffset.forEach((off, i) => expect(idx.end(off)).toBe(i + 1 < byOffset.length ? byOffset[i + 1] : packSize - 20));
    expect(() => idx.end(13)).toThrow(/not an object/);
    expect(Array.from({ length: idx.n }, (_, i) => idx.oidAt(i))).toEqual(rows.map((r) => r[0]).sort());
  });

  it('refuses an index it cannot read (version 1, truncated)', () => {
    const good = buildIdx([['ab'.repeat(20), 12]]);
    expect(() => new PackIndex(good, 100)).not.toThrow();
    expect(() => new PackIndex(new Uint8Array(2000), 100)).toThrow(/unsupported pack index/); // v1 has no magic number
    expect(() => new PackIndex(good.subarray(0, 8 + 1024 + 20), 100)).toThrow(/truncated/);
  });
});

// --- loose objects --------------------------------------------------------------------------------
describe('loose objects', () => {
  const loose = (type: string, content: Uint8Array, declaredSize = content.length): [string, Uint8Array] => {
    const oid = hashObject(type, content);
    return [`objects/${oid.slice(0, 2)}/${oid.slice(2)}`, zlibSync(concat([enc(`${type} ${declaredSize}\0`), content]))];
  };

  it('every type reads back, including an empty blob and content with NUL bytes and spaces', () => {
    const contents: [string, Uint8Array][] = [
      ['blob', new Uint8Array(0)], ['blob', enc('hello\n')], ['blob', new Uint8Array([0, 32, 0, 255, 10, 0])],
      ['blob', new Uint8Array(200000).map((_, i) => (i * i) & 255)],
      ['tree', concat([enc('100644 a b.txt\0'), hexToBytes('ab'.repeat(20))])],
      ['commit', enc(`tree ${'ab'.repeat(20)}\nauthor A <a@example.com> 1 +0000\ncommitter A <a@example.com> 1 +0000\n\nmsg\n`)],
      ['tag', enc(`object ${'ab'.repeat(20)}\ntype commit\ntag t\n\nmsg\n`)],
    ];
    const repo = openGitRepo(new MemoryGitFs(Object.fromEntries(contents.map(([t, c]) => loose(t, c)))));
    for (const [type, content] of contents) {
      const oid = hashObject(type, content);
      const obj = repo.readObject(oid)!;
      expect(obj.type).toBe(type);
      expect(Buffer.from(obj.data).equals(Buffer.from(content))).toBe(true);
      expect(repo.isPacked(oid)).toBe(false);
      expect(repo.packOffset(oid)).toBe(-1);
      expect(repo.locate(oid)).toBeNull();
      expect(repo.odb.has(hexToBytes(oid))).toBe(true);
      expect(repo.readObject(oid)!.data).toEqual(obj.data); // second read comes from the cache
    }
    expect(repo.readObject('f'.repeat(40))).toBeNull();
    expect(repo.odb.has(hexToBytes('f'.repeat(40)))).toBe(false);
    for (const notAnId of ['', 'HEAD', 'abc', 'G'.repeat(40)]) expect(repo.readObject(notAnId)).toBeNull();
  });

  it('a loose file that is not a git object is an error', () => {
    const [p1, good] = loose('blob', enc('x'));
    const oidOf = (p: string): string => p.slice(8).replace('/', '');
    const fs = new MemoryGitFs({
      [p1]: good.subarray(0, good.length - 3),                               // cut short
      ['objects/11/' + '1'.repeat(38)]: zlibSync(enc('bogus 1\0x')),         // unknown type
      ['objects/22/' + '2'.repeat(38)]: zlibSync(enc('no header at all')),   // no "<type> <size>\0"
      ['objects/33/' + '3'.repeat(38)]: enc('not zlib'),
    });
    const repo = openGitRepo(fs);
    expect(() => repo.readObject(oidOf(p1))).toThrow();
    expect(() => repo.readObject('11' + '1'.repeat(38))).toThrow(/unknown type/);
    expect(() => repo.readObject('22' + '2'.repeat(38))).toThrow(/malformed/);
    expect(() => repo.readObject('33' + '3'.repeat(38))).toThrow();
  });
});

// --- a scripted repo: loose, then packed with delta chains, then repacked --------------------------
/** ~25 KB of text; version n rewrites a few lines and keeps the edits of the versions before it. */
function bigText(version: number): string {
  let seed = 11;
  const lines: string[] = [];
  for (let i = 0; i < 900; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const by = i % 40;
    lines.push(by >= 1 && by <= version ? `edited in version ${by}: ${(seed ^ 0x5bd1e995).toString(36)}` : `line ${i} ${seed.toString(36)}`);
  }
  return lines.join('\n') + '\n';
}
const VERSIONS = 7;

function buildDeltaRepo(): string {
  const dir = path.join(projectRoot(), '.fixtures', 'git-x-objects');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  const data = (text: string): string => `data ${Buffer.byteLength(text)}\n${text}\n`;
  const who = 'T <t@example.com>';
  let stream = '';
  for (let n = 0; n < VERSIONS; n++) {
    stream += `commit refs/heads/main\nmark :${n + 1}\nauthor ${who} ${1704844800 + n * 86400} +0000\ncommitter ${who} ${1704844800 + n * 86400} +0000\n${data(`edit ${n}`)}`;
    if (n > 0) stream += `from :${n}\n`;
    stream += `M 100644 inline big.txt\n${data(bigText(n))}`;
    stream += `M 100644 inline dir/note${n}.txt\n${data(`note ${n}\n`)}`;
    if (n === 0) stream += `M 100644 inline empty.txt\n${data('')}`;
    stream += '\n';
  }
  execFileSync('git', ['-c', 'fastimport.unpackLimit=100000', 'fast-import', '--quiet'], { cwd: dir, input: stream, stdio: ['pipe', 'pipe', 'pipe'] });
  return dir;
}
/** Every loose object id in a .git directory. */
function looseIds(dir: string): string[] {
  const objects = path.join(dir, '.git', 'objects');
  return readdirSync(objects).filter((d) => /^[0-9a-f]{2}$/.test(d)).flatMap((d) => readdirSync(path.join(objects, d)).map((f) => d + f));
}
/** `git verify-pack -v` rows for every pack: what git says is stored where. */
function verifyPack(dir: string): { oid: string; type: string; size: number; offset: number; depth: number }[] {
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  const idx = readdirSync(packDir).filter((f) => f.endsWith('.idx')).map((f) => path.join(packDir, f));
  return git(dir, ['verify-pack', '-v', ...idx]).split('\n').map((l) => l.trim().split(/\s+/))
    .filter((c) => isOid(c[0]) && c.length >= 5)
    .map((c) => ({ oid: c[0], type: c[1], size: Number(c[2]), offset: Number(c[4]), depth: c.length >= 7 ? Number(c[5]) : 0 }));
}
function expectReadable(repo: GitRepository, ids: string[]): void {
  for (const oid of ids) {
    const obj = repo.readObject(oid);
    expect(obj, oid).not.toBeNull();
    expect(hashObject(obj!.type, obj!.data), oid).toBe(oid);
  }
}

describe('object store on a scripted repo', () => {
  it('reads the same objects loose, packed as delta chains, through tiny caches, and after a repack', () => {
    const dir = buildDeltaRepo();
    const fs = new NodeGitFs(path.join(dir, '.git'));
    try {
      // 1. everything loose
      const ids = looseIds(dir);
      expect(ids.length).toBe(VERSIONS * 5 + 1); // per commit: the commit, two trees, big.txt and a note; plus empty.txt
      const looseRepo = openGitRepo(fs);
      expect(looseRepo.odb.packedCount).toBe(0);
      expectReadable(looseRepo, ids);
      const head = looseRepo.head().oid!;
      const emptyBlob = hashObject('blob', new Uint8Array(0));
      expect(ids).toContain(emptyBlob);
      const versions = Array.from({ length: VERSIONS }, (_, n) => hashObject('blob', enc(bigText(n))));
      for (const v of versions) expect(ids).toContain(v);

      // 2. one pack with delta chains
      git(dir, ['repack', '-q', '-a', '-d', '-f', '--depth=20', '--window=20']);
      expect(looseIds(dir)).toEqual([]);
      const stored = verifyPack(dir);
      expect(stored.map((s) => s.oid).sort()).toEqual([...ids].sort());
      const deepest = stored.reduce((a, b) => (b.depth > a.depth ? b : a));
      expect(deepest.depth).toBeGreaterThan(1);

      const options: GitRepoOptions[] = [
        {},
        { pageBytes: 256, cacheBytes: 2048, pageCacheBytes: 1024 }, // everything evicted all the time
        { pageBytes: 0, cacheBytes: 0, pageCacheBytes: 0 },         // no paging, nothing cached
        { pageBytes: 1 << 20, cacheBytes: 1 << 26, pageCacheBytes: 1 << 26 },
      ];
      for (const opts of options) {
        const repo = openGitRepo(fs, opts);
        // the deepest object first, into empty caches: its whole chain is walked
        const first = repo.readObject(deepest.oid)!;
        expect(hashObject(first.type, first.data)).toBe(deepest.oid);
        expect(repo.odb.stats.maxChain).toBe(deepest.depth);
        for (const s of stored) {
          const obj = repo.readObject(s.oid)!;
          expect(obj.type).toBe(s.type);
          if (s.depth === 0) expect(obj.data.length).toBe(s.size); // for a delta, git lists the size of the delta
          expect(hashObject(obj.type, obj.data), s.oid).toBe(s.oid);
          expect(repo.packOffset(s.oid)).toBe(s.offset);
          expect(repo.isPacked(s.oid)).toBe(true);
        }
        expect(repo.odb.packedCount).toBe(stored.length);
        expect(repo.readObject(emptyBlob)!.data.length).toBe(0);
        versions.forEach((v, n) => expect(new TextDecoder().decode(repo.readObject(v)!.data)).toBe(bigText(n)));
        expect(repo.head().oid).toBe(head);
      }

      // 3. the packs change under an open repo (a gc or a fetch): reload() picks up the new layout
      const open = openGitRepo(fs);
      expectReadable(open, ids);
      const before = new Map(stored.map((s) => [s.oid, s.offset]));
      fs.close(); // Windows cannot replace a pack that is held open
      git(dir, ['repack', '-q', '-a', '-d', '-F', '--depth=1', '--window=5']);
      const after = verifyPack(dir);
      expect(after.some((s) => before.get(s.oid) !== s.offset)).toBe(true);
      open.odb.reload();
      expectReadable(open, ids);
      for (const s of after) expect(open.packOffset(s.oid)).toBe(s.offset);
    } finally {
      fs.close();
    }
  });
});

describe('node access stays inside its root', () => {
  it('paths with "..", absolute paths and backslashes read as missing', async () => {
    const dir = buildFixtureRepo('three-lang');
    const tree = new NodeWorkingTree(path.join(dir, 'web'));
    expect(await tree.read('tsconfig.json')).not.toBeNull();
    for (const p of ['../README.md', 'src/../../README.md', path.join(dir, 'README.md'), '..\\README.md']) {
      expect(await tree.read(p), p).toBeNull();
      expect(await tree.stat(p), p).toBeNull();
    }
    expect(await tree.list('..')).toEqual([]);
    expect(await tree.stat('src')).toBeNull(); // a folder is not a file

    const fs = new NodeGitFs(path.join(dir, '.git', 'refs'));
    expect(fs.list('heads')).toContain('main');
    expect(fs.size('../HEAD')).toBe(-1);
    expect(fs.list('..')).toEqual([]);
    expect(() => fs.readAt('../HEAD', 0, 4)).toThrow(/bad path/);
  });
});
