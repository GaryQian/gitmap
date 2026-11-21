// Object database: pack .idx v2 + .pack random access, OFS and REF deltas, loose objects, and a
// two-generation cache of resolved objects. Ported from spikes/git/core/odb.ts, which matched git
// on every object it read in react, flutter and tensorflow. Synchronous throughout.
import { unzlibSync } from 'fflate';
import type { GitFs, GitObjectType } from '../contracts/git';
import { hexToBytes, isOid, toHex } from './bytes';
import { PageCache, PagedFile, type IoStats } from './paged';

/** Object type codes as stored in packs. */
export const T_COMMIT = 1, T_TREE = 2, T_BLOB = 3, T_TAG = 4;
const T_OFS = 6, T_REF = 7;

const TYPE_NAMES: (GitObjectType | undefined)[] = [undefined, 'commit', 'tree', 'blob', 'tag'];
/** 'commit' | 'tree' | 'blob' | 'tag' for a type code. */
export function typeName(code: number): GitObjectType {
  const n = TYPE_NAMES[code];
  if (!n) throw new Error(`git: unknown object type code ${code}`);
  return n;
}

/** An object as read from the database. `data` may be shared with the cache: do not mutate it. */
export interface RawObject {
  /** T_COMMIT, T_TREE, T_BLOB or T_TAG. */
  type: number;
  data: Uint8Array;
}

/** One pack's .idx (version 2): object id → offset, and the extent of each object in the pack. */
export class PackIndex {
  /** Number of objects in the pack. */
  readonly n: number;
  private dv: DataView;
  private fanout: Uint32Array;
  private oids: Uint8Array;
  private off32At: number;
  private off64At: number;
  private sorted: Uint32Array | Float64Array | null = null;

  constructor(buf: Uint8Array, readonly packSize: number) {
    const dv = (this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength));
    if (buf.length < 8 + 1024 || dv.getUint32(0) !== 0xff744f63 || dv.getUint32(4) !== 2) {
      throw new Error('git: unsupported pack index (only .idx version 2 is read)');
    }
    this.fanout = new Uint32Array(256);
    for (let i = 0; i < 256; i++) this.fanout[i] = dv.getUint32(8 + i * 4);
    const n = (this.n = this.fanout[255]);
    const oidAt = 8 + 1024;
    this.oids = buf.subarray(oidAt, oidAt + n * 20);
    this.off32At = oidAt + n * 20 + n * 4; // after the CRC table
    this.off64At = this.off32At + n * 4;
    if (buf.length < this.off64At) throw new Error('git: truncated pack index');
  }

  /** Pack offset of the i-th object in id order. */
  offsetAt(i: number): number {
    const v = this.dv.getUint32(this.off32At + i * 4);
    if (v & 0x80000000) {
      const at = this.off64At + (v & 0x7fffffff) * 8;
      return this.dv.getUint32(at) * 4294967296 + this.dv.getUint32(at + 4);
    }
    return v;
  }

  /** Object id (hex) of the i-th object in id order. */
  oidAt(i: number): string {
    return toHex(this.oids, i * 20);
  }

  /** Pack offset of the object whose 20-byte id is at oid[at..], or −1. */
  find(oid: Uint8Array, at = 0): number {
    const b0 = oid[at];
    let lo = b0 === 0 ? 0 : this.fanout[b0 - 1];
    let hi = this.fanout[b0] - 1;
    const o = this.oids;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const base = mid * 20;
      let c = 0;
      for (let i = 1; i < 20; i++) {
        c = o[base + i] - oid[at + i];
        if (c !== 0) break;
      }
      if (c === 0) return this.offsetAt(mid);
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** End of the object that starts at `off`: the start of the next object, or of the pack trailer. */
  end(off: number): number {
    let s = this.sorted;
    if (!s) {
      s = this.packSize < 4294967296 ? new Uint32Array(this.n) : new Float64Array(this.n);
      for (let i = 0; i < this.n; i++) s[i] = this.offsetAt(i);
      s.sort();
      this.sorted = s;
    }
    let lo = 0, hi = s.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (s[mid] < off) lo = mid + 1;
      else if (s[mid] > off) hi = mid - 1;
      else return mid + 1 < s.length ? s[mid + 1] : this.packSize - 20;
    }
    throw new Error(`git: offset ${off} is not an object in the pack`);
  }
}

/**
 * Two-generation cache with a byte budget (approximate LRU). Each generation holds up to half the
 * budget; when the young one fills it becomes the old one and the previous old generation is dropped.
 * Hits in the old generation are promoted.
 */
class ObjectCache {
  private young = new Map<number | string, RawObject>();
  private old = new Map<number | string, RawObject>();
  private youngBytes = 0;
  hits = 0;
  misses = 0;
  constructor(readonly max: number) {}
  get(k: number | string): RawObject | undefined {
    let v = this.young.get(k);
    if (v) { this.hits++; return v; }
    v = this.old.get(k);
    if (v) {
      this.hits++;
      this.old.delete(k);
      this.insert(k, v);
      return v;
    }
    this.misses++;
    return undefined;
  }
  set(k: number | string, v: RawObject): void {
    if (v.data.length + 80 > this.max / 4 || this.young.has(k)) return;
    this.insert(k, v);
  }
  private insert(k: number | string, v: RawObject): void {
    this.young.set(k, v);
    this.youngBytes += v.data.length + 80;
    if (this.youngBytes > this.max / 2) {
      this.old = this.young;
      this.young = new Map();
      this.youngBytes = 0;
    }
  }
}

export interface ObjectDbOptions {
  /** Page size for pack reads. */
  pageBytes: number;
  /** Budget of the resolved-object cache. */
  cacheBytes: number;
  /** Budget of the pack page cache, shared by all packs. */
  pageCacheBytes: number;
}

export interface ObjectDbStats {
  io: IoStats;
  objectReads: number;
  inflates: number;
  deltas: number;
  maxChain: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

interface Pack {
  name: string;
  idx: PackIndex;
  file: PagedFile;
}

const KEYMUL = 2 ** 40; // cache key = pack number × 2^40 + offset
const EMPTY = new Uint8Array(0);

export class ObjectDb {
  private loaded: Pack[] | null = null;
  private cache: ObjectCache;
  private pages: PageCache;
  private lastPack = 0;
  readonly stats: ObjectDbStats;

  constructor(readonly fs: GitFs, private opts: ObjectDbOptions) {
    this.cache = new ObjectCache(opts.cacheBytes);
    this.pages = new PageCache(opts.pageBytes, opts.pageCacheBytes);
    const cache = (): ObjectCache => this.cache;
    this.stats = {
      io: { calls: 0, bytes: 0 }, objectReads: 0, inflates: 0, deltas: 0, maxChain: 0,
      get cacheHits() { return cache().hits; },
      get cacheMisses() { return cache().misses; },
    };
  }

  /** The packs, loaded on first use. A pack index is read whole, once. */
  get packs(): readonly Pack[] {
    if (this.loaded) return this.loaded;
    const fs = this.fs;
    const packs: Pack[] = [];
    for (const name of fs.list('objects/pack').sort()) {
      if (!name.endsWith('.idx')) continue;
      const base = 'objects/pack/' + name.slice(0, -4);
      const packSize = fs.size(base + '.pack');
      const idxSize = fs.size(base + '.idx');
      if (packSize < 0 || idxSize < 0) continue;
      const idx = new PackIndex(fs.readAt(base + '.idx', 0, idxSize), packSize);
      packs.push({ name: name.slice(0, -4), idx, file: new PagedFile(fs, base + '.pack', packSize, this.pages, packs.length, this.stats.io) });
    }
    return (this.loaded = packs);
  }

  /** Forget the packs and caches, so the next read lists objects/pack again (after a gc or a fetch). */
  reload(): void {
    this.loaded = null;
    this.cache = new ObjectCache(this.opts.cacheBytes);
    this.pages = new PageCache(this.opts.pageBytes, this.opts.pageCacheBytes);
  }

  /** Total number of packed objects. */
  get packedCount(): number {
    return this.packs.reduce((a, p) => a + p.idx.n, 0);
  }

  /** Which pack holds the object whose 20-byte id is at oid[at..], and where. Null when not packed. */
  locate(oid: Uint8Array, at = 0): { pack: number; offset: number } | null {
    const packs = this.packs;
    const n = packs.length;
    for (let k = 0; k < n; k++) {
      const p = (this.lastPack + k) % n; // objects read together tend to live in the same pack
      const offset = packs[p].idx.find(oid, at);
      if (offset >= 0) {
        this.lastPack = p;
        return { pack: p, offset };
      }
    }
    return null;
  }

  /** True when the object exists, packed or loose. */
  has(oid: Uint8Array, at = 0): boolean {
    return this.locate(oid, at) !== null || this.fs.size(loosePath(toHex(oid, at))) >= 0;
  }

  /** Read the object whose 20-byte id is at oid[at..]. Null when absent. */
  read(oid: Uint8Array, at = 0): RawObject | null {
    this.stats.objectReads++;
    const loc = this.locate(oid, at);
    if (loc) return this.readPacked(loc.pack, loc.offset);
    return this.readLoose(toHex(oid, at));
  }

  /** Read an object by hex id. Null when absent or when `hex` is not an object id. */
  readHex(hex: string): RawObject | null {
    return isOid(hex) ? this.read(hexToBytes(hex)) : null;
  }

  private inflate(src: Uint8Array, size: number): Uint8Array {
    if (size === 0) return EMPTY;
    this.stats.inflates++;
    return unzlibSync(src, { out: new Uint8Array(size) });
  }

  /** Read a loose object (objects/xx/yyyy…): zlib of "<type> <size>\0<content>". Null when absent. */
  readLoose(hex: string): RawObject | null {
    const cached = this.cache.get(hex);
    if (cached) return cached;
    const path = loosePath(hex);
    const size = this.fs.size(path);
    if (size < 0) return null;
    this.stats.io.calls++;
    this.stats.io.bytes += size;
    this.stats.inflates++;
    const all = unzlibSync(this.fs.readAt(path, 0, size));
    const sp = all.indexOf(32);
    const nul = all.indexOf(0);
    if (sp < 1 || sp > 8 || nul < sp) throw new Error(`git: malformed loose object ${hex}`);
    const tname = String.fromCharCode(...all.subarray(0, sp));
    const type = TYPE_NAMES.indexOf(tname as GitObjectType);
    if (type < 1) throw new Error(`git: loose object ${hex} has unknown type "${tname}"`);
    const obj: RawObject = { type, data: all.subarray(nul + 1) };
    this.cache.set(hex, obj);
    return obj;
  }

  /** Read the object at `offset` of pack number `packI`, resolving its delta chain without recursion. */
  readPacked(packI: number, offset: number): RawObject {
    const packs = this.packs;
    const chainKeys: number[] = [];
    const chainDeltas: Uint8Array[] = [];
    let p = packI;
    let off = offset;
    let base: RawObject | undefined;
    for (;;) {
      const key = p * KEYMUL + off;
      const c = this.cache.get(key);
      if (c) { base = c; break; }
      const pack = packs[p];
      const buf = pack.file.read(off, pack.idx.end(off) - off);
      // header: type in bits 4–6 of the first byte, size as a little-endian base-128 number
      let pos = 0;
      let b = buf[pos++];
      const type = (b >> 4) & 7;
      let size = b & 15;
      let shift = 4;
      while (b & 128) {
        b = buf[pos++];
        size += (b & 127) * 2 ** shift;
        shift += 7;
      }
      if (type === T_OFS) {
        // base is at a negative offset in the same pack
        b = buf[pos++];
        let neg = b & 127;
        while (b & 128) {
          b = buf[pos++];
          neg = (neg + 1) * 128 + (b & 127);
        }
        chainKeys.push(key);
        chainDeltas.push(this.inflate(buf.subarray(pos), size));
        off -= neg;
        continue;
      }
      if (type === T_REF) {
        // base is named by object id; it may be in another pack, or loose
        const baseOid = buf.slice(pos, pos + 20);
        pos += 20;
        chainKeys.push(key);
        chainDeltas.push(this.inflate(buf.subarray(pos), size));
        const loc = this.locate(baseOid);
        if (loc) { p = loc.pack; off = loc.offset; continue; }
        const loose = this.readLoose(toHex(baseOid));
        if (!loose) throw new Error(`git: delta base ${toHex(baseOid)} is missing`);
        base = loose;
        break;
      }
      if (type < T_COMMIT || type > T_TAG) throw new Error(`git: bad object type ${type} at ${pack.name}:${off}`);
      base = { type, data: this.inflate(buf.subarray(pos), size) };
      this.cache.set(key, base);
      break;
    }
    const depth = chainDeltas.length;
    if (depth > this.stats.maxChain) this.stats.maxChain = depth;
    for (let i = depth - 1; i >= 0; i--) {
      this.stats.deltas++;
      base = { type: base.type, data: applyDelta(base.data, chainDeltas[i]) };
      this.cache.set(chainKeys[i], base);
    }
    return base;
  }
}

function loosePath(hex: string): string {
  return 'objects/' + hex.slice(0, 2) + '/' + hex.slice(2);
}

/** Apply a git delta (copy / insert instructions) to its base. */
export function applyDelta(base: Uint8Array, d: Uint8Array): Uint8Array {
  let p = 0;
  let c: number;
  let shift = 0;
  let bsz = 0;
  do {
    c = d[p++];
    bsz += (c & 127) * 2 ** shift;
    shift += 7;
  } while (c & 128);
  if (bsz !== base.length) throw new Error('git: delta base size mismatch');
  shift = 0;
  let rsz = 0;
  do {
    c = d[p++];
    rsz += (c & 127) * 2 ** shift;
    shift += 7;
  } while (c & 128);
  const out = new Uint8Array(rsz);
  let o = 0;
  const n = d.length;
  while (p < n) {
    const op = d[p++];
    if (op & 128) {
      let off = 0;
      let sz = 0;
      if (op & 1) off = d[p++];
      if (op & 2) off |= d[p++] << 8;
      if (op & 4) off |= d[p++] << 16;
      if (op & 8) off += d[p++] * 16777216;
      if (op & 16) sz = d[p++];
      if (op & 32) sz |= d[p++] << 8;
      if (op & 64) sz |= d[p++] << 16;
      if (sz === 0) sz = 0x10000;
      if (off + sz > bsz || o + sz > rsz) throw new Error('git: delta copy out of range');
      if (sz < 24) for (let i = 0; i < sz; i++) out[o++] = base[off + i];
      else {
        out.set(base.subarray(off, off + sz), o);
        o += sz;
      }
    } else if (op) {
      if (o + op > rsz) throw new Error('git: delta insert out of range');
      if (op < 24) for (let i = 0; i < op; i++) out[o++] = d[p++];
      else {
        out.set(d.subarray(p, p + op), o);
        o += op;
        p += op;
      }
    } else throw new Error('git: bad delta opcode 0');
  }
  if (o !== rsz) throw new Error('git: delta result size mismatch');
  return out;
}
