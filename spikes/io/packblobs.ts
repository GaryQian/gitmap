// Spike: is reading HEAD/index blobs out of the git packfile faster than opening every
// working-tree file? Single thread, Node stand-in for the browser read paths.
//   npx tsx io/packblobs.ts <repo> [pageSize=65536] [order=offset|path] [first=tree|pack]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseGitIndex } from '../scan/gitindex.ts';
import { langOf } from '../scan/scanner.ts';
import { Odb, hexToBytes, T_BLOB } from '../git/core/odb.ts';
import { NodeGitFs } from '../git/node-fs.ts';

const repo = process.argv[2];
const pageSize = Number(process.argv[3] ?? 65536);
const order = process.argv[4] ?? 'offset';
const first = process.argv[5] ?? 'tree';
const gitDir = path.join(repo, '.git');
const now = () => performance.now();

const entries = parseGitIndex(fs.readFileSync(path.join(gitDir, 'index'))).filter(
  (e) => (e.mode & 0o170000) === 0o100000 && e.size <= 1_048_576 && langOf(e.path),
);

function readTree() {
  let bytes = 0, missing = 0;
  const t = now();
  for (const e of entries) {
    try { bytes += fs.readFileSync(path.join(repo, e.path)).length; } catch { missing++; }
  }
  return { ms: now() - t, bytes, missing };
}

function readPack() {
  const tOpen = now();
  const odb = new Odb(new NodeGitFs(gitDir), {
    cacheBytes: 256 << 20, pageSize, maxPages: Math.max(8, Math.ceil((64 << 20) / pageSize)), profile: true,
  });
  const openMs = now() - tOpen;
  const tLoc = now();
  const packed: { p: number; off: number; i: number }[] = [];
  const loose: number[] = [];
  let compressed = 0, minOff = Infinity, maxOff = 0;
  entries.forEach((e, i) => {
    const oid = hexToBytes(e.oid);
    for (let p = 0; p < odb.packs.length; p++) {
      const off = odb.packs[p].idx.find(oid);
      if (off >= 0) {
        packed.push({ p, off, i });
        compressed += odb.packs[p].idx.end(off) - off;
        if (off < minOff) minOff = off;
        if (off > maxOff) maxOff = off;
        return;
      }
    }
    loose.push(i);
  });
  if (order === 'offset') packed.sort((a, b) => a.p - b.p || a.off - b.off);
  const locateMs = now() - tLoc;
  let bytes = 0, notBlob = 0, looseOk = 0, looseMissing = 0;
  const t = now();
  for (const l of packed) {
    const o = odb.readPacked(l.p, l.off);
    bytes += o.data.length;
    if (o.type !== T_BLOB) notBlob++;
  }
  const packMs = now() - t;
  const tL = now();
  for (const i of loose) {
    try { bytes += odb.read(hexToBytes(entries[i].oid)).data.length; looseOk++; } catch { looseMissing++; }
  }
  const looseMs = now() - tL;
  // correctness sample: blob bytes vs working-tree bytes
  let same = 0, sameAfterCrlf = 0, differ = 0;
  const step = Math.max(1, Math.floor(packed.length / 300));
  for (let k = 0; k < packed.length; k += step) {
    const e = entries[packed[k].i];
    let wt: Buffer;
    try { wt = fs.readFileSync(path.join(repo, e.path)); } catch { continue; }
    const blob = Buffer.from(odb.readPacked(packed[k].p, packed[k].off).data);
    if (blob.equals(wt)) same++;
    else if (Buffer.from(wt.toString('latin1').replace(/\r\n/g, '\n'), 'latin1').equals(blob)) sameAfterCrlf++;
    else differ++;
  }
  const s = odb.stats;
  return {
    openMs: +openMs.toFixed(1), locateMs: +locateMs.toFixed(1), packMs: +packMs.toFixed(1), looseMs: +looseMs.toFixed(1),
    packedFiles: packed.length, looseFiles: looseOk, looseMissing, notBlob, bytesMB: +(bytes / 1e6).toFixed(1),
    compressedMB: +(compressed / 1e6).toFixed(1), spanMB: +((maxOff - minOff) / 1e6).toFixed(1),
    packSizeMB: +(odb.packs.reduce((a, p) => a + p.idx.packSize, 0) / 1e6).toFixed(1), packs: odb.packs.length,
    ioCalls: s.io.calls, ioMB: +(s.io.bytes / 1e6).toFixed(1), ioMs: +s.io.ms.toFixed(1),
    inflateMs: +s.inflateMs.toFixed(1), inflateMBOut: +(s.inflateBytesOut / 1e6).toFixed(1),
    deltaMs: +s.deltaMs.toFixed(1), deltaCalls: s.deltaCalls, maxChain: s.maxChain,
    avgChain: s.chainCount ? +(s.chainSum / s.chainCount).toFixed(2) : 0,
    cacheHits: odb.cache.hits, cacheMisses: odb.cache.misses,
    sample: { same, sameAfterCrlf, differ },
  };
}

const out: Record<string, unknown> = { repo, files: entries.length, pageSize, order, first };
if (first === 'tree') { out.tree = readTree(); out.pack = readPack(); }
else { out.pack = readPack(); out.tree = readTree(); }
out.peakRssMB = Math.round(process.memoryUsage().rss / 1e6);
console.log(JSON.stringify(out, null, 1));
