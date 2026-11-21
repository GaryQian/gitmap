// Object database: pack .idx v2 + .pack random access, loose objects, delta resolution,
// LRU cache of resolved objects. Uses only Uint8Array/DataView + fflate (sync).
import { unzlibSync } from 'fflate';
import { GitFs, IoStats, PagedFile, now } from './fs.ts';

export const T_COMMIT = 1, T_TREE = 2, T_BLOB = 3, T_TAG = 4, T_OFS = 6, T_REF = 7;

export interface GitObject {
  type: number;
  data: Uint8Array;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export function toHex(b: Uint8Array, at = 0): string {
  let s = '';
  for (let i = at; i < at + 20; i++) s += HEX[b[i]];
  return s;
}
function hexVal(c: number): number {
  return c <= 57 ? c - 48 : (c | 32) - 87;
}
export function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = (hexVal(s.charCodeAt(2 * i)) << 4) | hexVal(s.charCodeAt(2 * i + 1));
  return out;
}
/** hex (ascii bytes) inside a buffer -> 20 bytes */
export function asciiHexToBytes(b: Uint8Array, at: number): Uint8Array {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = (hexVal(b[at + 2 * i]) << 4) | hexVal(b[at + 2 * i + 1]);
  return out;
}

export class PackIndex {
  readonly n: number;
  private fanout: Uint32Array;
  private oids: Uint8Array;
  private offsets: Float64Array;
  private sorted: Float64Array;
  constructor(buf: Uint8Array, readonly packSize: number) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint32(0) !== 0xff744f63 || dv.getUint32(4) !== 2) throw new Error('unsupported idx version');
    this.fanout = new Uint32Array(256);
    for (let i = 0; i < 256; i++) this.fanout[i] = dv.getUint32(8 + i * 4);
    const n = (this.n = this.fanout[255]);
    const oidAt = 8 + 1024;
    this.oids = buf.subarray(oidAt, oidAt + n * 20);
    const off32At = oidAt + n * 20 + n * 4;
    const off64At = off32At + n * 4;
    this.offsets = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = dv.getUint32(off32At + i * 4);
      if (v & 0x80000000) {
        const k = v & 0x7fffffff;
        this.offsets[i] = dv.getUint32(off64At + k * 8) * 4294967296 + dv.getUint32(off64At + k * 8 + 4);
      } else this.offsets[i] = v;
    }
    this.sorted = Float64Array.from(this.offsets).sort();
  }

  /** pack offset of oid (20 bytes at `at`), or -1 */
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
      if (c === 0) return this.offsets[mid];
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** end of the object starting at `off` (start of next object, or trailer) */
  end(off: number): number {
    const s = this.sorted;
    let lo = 0, hi = s.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (s[mid] < off) lo = mid + 1;
      else if (s[mid] > off) hi = mid - 1;
      else return mid + 1 < s.length ? s[mid + 1] : this.packSize - 20;
    }
    throw new Error('offset not in index: ' + off);
  }
}

/**
 * Two-generation cache with a byte budget (approximate LRU). Each generation holds up
 * to max/2 bytes; when the young one fills it becomes the old one and the previous old
 * generation is dropped wholesale. Hits in the old generation are promoted.
 * (A Map-based LRU that evicts via map.keys().next() is O(deleted holes) in V8 and was
 * measured to take ~50% of total walk time.)
 */
class Lru {
  young = new Map<number, GitObject>();
  old = new Map<number, GitObject>();
  youngBytes = 0;
  oldBytes = 0;
  hits = 0;
  misses = 0;
  constructor(public max: number) {}
  get bytes() {
    return this.youngBytes + this.oldBytes;
  }
  get(k: number): GitObject | undefined {
    let v = this.young.get(k);
    if (v) {
      this.hits++;
      return v;
    }
    v = this.old.get(k);
    if (v) {
      this.hits++;
      this.old.delete(k);
      this.oldBytes -= v.data.length + 80;
      this.insert(k, v);
      return v;
    }
    this.misses++;
    return undefined;
  }
  set(k: number, v: GitObject) {
    if (this.young.has(k)) return;
    const sz = v.data.length + 80;
    if (sz > this.max / 4) return;
    this.insert(k, v);
  }
  private insert(k: number, v: GitObject) {
    this.young.set(k, v);
    this.youngBytes += v.data.length + 80;
    if (this.youngBytes > this.max / 2) {
      this.old = this.young;
      this.oldBytes = this.youngBytes;
      this.young = new Map();
      this.youngBytes = 0;
    }
  }
}

export interface OdbStats {
  io: IoStats;
  inflateMs: number;
  inflateCalls: number;
  inflateBytesOut: number;
  deltaMs: number;
  deltaCalls: number;
  maxChain: number;
  chainSum: number;
  chainCount: number;
  lookupMs: number;
  objectReads: number;
  byType: number[];
}

export interface OdbOptions {
  cacheBytes?: number;
  pageSize?: number;
  maxPages?: number;
  profile?: boolean;
}

interface Pack {
  idx: PackIndex;
  file: PagedFile;
}

const KEYMUL = 2 ** 40;

export class Odb {
  packs: Pack[] = [];
  loose = new Set<string>();
  cache: Lru;
  stats: OdbStats = {
    io: { calls: 0, bytes: 0, ms: 0 },
    inflateMs: 0,
    inflateCalls: 0,
    inflateBytesOut: 0,
    deltaMs: 0,
    deltaCalls: 0,
    maxChain: 0,
    chainSum: 0,
    chainCount: 0,
    lookupMs: 0,
    objectReads: 0,
    byType: [0, 0, 0, 0, 0, 0, 0, 0],
  };
  idxLoadMs = 0;
  private profile: boolean;

  constructor(private fs: GitFs, opts: OdbOptions = {}) {
    this.cache = new Lru(opts.cacheBytes ?? 64 * 1024 * 1024);
    this.profile = opts.profile ?? true;
    const t = now();
    for (const name of fs.list('objects/pack').sort()) {
      if (!name.endsWith('.idx')) continue;
      const base = 'objects/pack/' + name.slice(0, -4);
      const packSize = fs.size(base + '.pack');
      if (packSize < 0) continue;
      const idxSize = fs.size(base + '.idx');
      const idx = new PackIndex(fs.readAt(base + '.idx', 0, idxSize), packSize);
      this.packs.push({
        idx,
        file: new PagedFile(fs, base + '.pack', packSize, this.stats.io, opts.pageSize ?? 65536, opts.maxPages ?? 512),
      });
    }
    for (const d of fs.list('objects')) {
      if (d.length !== 2) continue;
      for (const f of fs.list('objects/' + d)) if (f.length === 38) this.loose.add(d + f);
    }
    this.idxLoadMs = now() - t;
  }

  get objectCount(): number {
    return this.packs.reduce((a, p) => a + p.idx.n, 0) + this.loose.size;
  }

  private inflate(src: Uint8Array, size: number): Uint8Array {
    if (!this.profile) return unzlibSync(src, { out: new Uint8Array(size) });
    const t = now();
    const out = unzlibSync(src, { out: new Uint8Array(size) });
    this.stats.inflateMs += now() - t;
    this.stats.inflateCalls++;
    this.stats.inflateBytesOut += size;
    return out;
  }

  /** read object by 20-byte oid at buf[at..at+20] */
  read(oid: Uint8Array, at = 0): GitObject {
    this.stats.objectReads++;
    const t = this.profile ? now() : 0;
    for (let p = 0; p < this.packs.length; p++) {
      const off = this.packs[p].idx.find(oid, at);
      if (off >= 0) {
        if (this.profile) this.stats.lookupMs += now() - t;
        return this.readPacked(p, off);
      }
    }
    if (this.profile) this.stats.lookupMs += now() - t;
    const hex = toHex(oid, at);
    if (this.loose.has(hex)) return this.readLoose(hex);
    throw new Error('object not found: ' + hex);
  }

  has(oid: Uint8Array, at = 0): boolean {
    for (const p of this.packs) if (p.idx.find(oid, at) >= 0) return true;
    return this.loose.has(toHex(oid, at));
  }

  private readLoose(hex: string): GitObject {
    // loose objects are not cached (only small/young repos rely on them heavily)
    const path = 'objects/' + hex.slice(0, 2) + '/' + hex.slice(2);
    const sz = this.fs.size(path);
    const t = now();
    const raw = this.fs.readAt(path, 0, sz);
    this.stats.io.ms += now() - t;
    this.stats.io.calls++;
    this.stats.io.bytes += sz;
    const t2 = now();
    const all = unzlibSync(raw);
    this.stats.inflateMs += now() - t2;
    this.stats.inflateCalls++;
    let sp = 0;
    while (all[sp] !== 32) sp++;
    let nul = sp;
    while (all[nul] !== 0) nul++;
    const tname = String.fromCharCode(...all.subarray(0, sp));
    const type = tname === 'commit' ? T_COMMIT : tname === 'tree' ? T_TREE : tname === 'blob' ? T_BLOB : T_TAG;
    this.stats.byType[type]++;
    return { type, data: all.subarray(nul + 1) };
  }

  readPacked(packI: number, offset: number): GitObject {
    const chainKeys: number[] = [];
    const chainDeltas: Uint8Array[] = [];
    let p = packI;
    let off = offset;
    let base: GitObject | undefined;
    for (;;) {
      const key = p * KEYMUL + off;
      const c = this.cache.get(key);
      if (c) {
        base = c;
        break;
      }
      const pack = this.packs[p];
      const end = pack.idx.end(off);
      const buf = pack.file.read(off, end - off);
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
        b = buf[pos++];
        let neg = b & 127;
        while (b & 128) {
          b = buf[pos++];
          neg = (neg + 1) * 128 + (b & 127);
        }
        chainKeys.push(key);
        chainDeltas.push(this.inflate(buf.subarray(pos), size));
        off = off - neg;
        continue;
      }
      if (type === T_REF) {
        const baseOid = buf.subarray(pos, pos + 20);
        pos += 20;
        chainKeys.push(key);
        chainDeltas.push(this.inflate(buf.subarray(pos), size));
        let found = false;
        for (let q = 0; q < this.packs.length; q++) {
          const o2 = this.packs[q].idx.find(baseOid);
          if (o2 >= 0) {
            p = q;
            off = o2;
            found = true;
            break;
          }
        }
        if (found) continue;
        base = this.readLoose(toHex(baseOid));
        break;
      }
      base = { type, data: this.inflate(buf.subarray(pos), size) };
      this.cache.set(key, base);
      break;
    }
    const depth = chainDeltas.length;
    if (depth > 0) {
      this.stats.chainSum += depth;
      this.stats.chainCount++;
      if (depth > this.stats.maxChain) this.stats.maxChain = depth;
      for (let i = depth - 1; i >= 0; i--) {
        const t = this.profile ? now() : 0;
        const data = applyDelta(base.data, chainDeltas[i]);
        if (this.profile) {
          this.stats.deltaMs += now() - t;
          this.stats.deltaCalls++;
        }
        base = { type: base.type, data };
        this.cache.set(chainKeys[i], base);
      }
    }
    this.stats.byType[base.type]++;
    return base;
  }
}

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
  if (bsz !== base.length) throw new Error('delta base size mismatch');
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
      if (sz < 24) for (let i = 0; i < sz; i++) out[o++] = base[off + i];
      else {
        out.set(base.subarray(off, off + sz), o);
        o += sz;
      }
    } else if (op) {
      if (op < 24) for (let i = 0; i < op; i++) out[o++] = d[p++];
      else {
        out.set(d.subarray(p, p + op), o);
        o += op;
        p += op;
      }
    } else throw new Error('bad delta opcode 0');
  }
  if (o !== rsz) throw new Error('delta result size mismatch');
  return out;
}
