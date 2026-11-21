// Parse .git/index (v2, v3, v4) into tracked paths with blob OID and file size.
// Pure TypeScript over a Uint8Array so the same code runs in a browser worker.
export interface IndexEntry { path: string; oid: string; size: number; mode: number }

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const td = new TextDecoder();

export function parseGitIndex(buf: Uint8Array): IndexEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sig = td.decode(buf.subarray(0, 4));
  if (sig !== 'DIRC') throw new Error('not a git index');
  const version = dv.getUint32(4);
  if (version < 2 || version > 4) throw new Error(`unsupported index version ${version}`);
  const count = dv.getUint32(8);
  const out: IndexEntry[] = new Array(count);
  let p = 12;
  let prev = '';
  for (let i = 0; i < count; i++) {
    const start = p;
    const mode = dv.getUint32(p + 24);
    const size = dv.getUint32(p + 36);
    let oid = '';
    for (let k = 0; k < 20; k++) oid += HEX[buf[p + 40 + k]];
    const flags = dv.getUint16(p + 60);
    p += 62;
    if (version >= 3 && flags & 0x4000) p += 2; // extended flags
    let path: string;
    if (version === 4) {
      // prefix-compressed: varint N = bytes to strip from previous path, then NUL-terminated suffix
      let n = 0, b: number;
      do { b = buf[p++]; n = (n << 7) | (b & 0x7f); if (b & 0x80) n += 1; } while (b & 0x80);
      // git's offset varint: each continuation adds 1 before shifting
      const end = buf.indexOf(0, p);
      path = prev.slice(0, prev.length - n) + td.decode(buf.subarray(p, end));
      p = end + 1;
    } else {
      const end = buf.indexOf(0, p);
      path = td.decode(buf.subarray(p, end));
      p = end;
      // pad entry to multiple of 8 bytes (1..8 NULs)
      const len = p - start;
      p = start + ((len + 8) & ~7);
    }
    prev = path;
    out[i] = { path, oid, size, mode };
  }
  return out;
}
