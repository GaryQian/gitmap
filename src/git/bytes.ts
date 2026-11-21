// Byte helpers shared by the git readers: hex ↔ bytes, text decoding, SHA-1.

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const td = new TextDecoder();

/** Hex of `len` bytes of `b` starting at `at` (default: one 20-byte object id). */
export function toHex(b: Uint8Array, at = 0, len = 20): string {
  let s = '';
  for (let i = at; i < at + len; i++) s += HEX[b[i]];
  return s;
}

function hexVal(c: number): number {
  return c <= 57 ? c - 48 : (c | 32) - 87;
}

/** Hex string → bytes (20 bytes for an object id). */
export function hexToBytes(s: string): Uint8Array {
  const n = s.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (hexVal(s.charCodeAt(2 * i)) << 4) | hexVal(s.charCodeAt(2 * i + 1));
  return out;
}

/** ASCII hex inside a buffer (as in commit and tag objects) → bytes. */
export function asciiHexToBytes(b: Uint8Array, at: number, len = 20): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (hexVal(b[at + 2 * i]) << 4) | hexVal(b[at + 2 * i + 1]);
  return out;
}

/** True for a full lower-case 40-character SHA-1 object id. */
export function isOid(s: string): boolean {
  return s.length === 40 && /^[0-9a-f]{40}$/.test(s);
}

/** UTF-8 text of b[start..end). Invalid sequences become U+FFFD; never throws. */
export function decodeText(b: Uint8Array, start = 0, end = b.length): string {
  return td.decode(start === 0 && end === b.length ? b : b.subarray(start, end));
}

/** SHA-1 of a byte array (synchronous; used for the index trailer and for checking objects). */
export function sha1(data: Uint8Array): Uint8Array {
  let h0 = 0x67452301, h1 = 0xefcdab89 | 0, h2 = 0x98badcfe | 0, h3 = 0x10325476, h4 = 0xc3d2e1f0 | 0;
  const w = new Int32Array(80);
  const block = (buf: Uint8Array, p: number): void => {
    for (let i = 0; i < 16; i++, p += 4) w[i] = (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  };
  const len = data.length;
  const whole = len - (len % 64);
  for (let p = 0; p < whole; p += 64) block(data, p);
  // last partial block + 0x80 + zero padding + 64-bit big-endian bit length
  const rest = len - whole;
  const tail = new Uint8Array(rest + 9 > 64 ? 128 : 64);
  tail.set(data.subarray(whole));
  tail[rest] = 0x80;
  const dv = new DataView(tail.buffer);
  dv.setUint32(tail.length - 8, Math.floor(len / 0x20000000));
  dv.setUint32(tail.length - 4, (len << 3) >>> 0);
  for (let p = 0; p < tail.length; p += 64) block(tail, p);
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setInt32(0, h0); odv.setInt32(4, h1); odv.setInt32(8, h2); odv.setInt32(12, h3); odv.setInt32(16, h4);
  return out;
}

/** The object id git gives to an object of this type and content. */
export function hashObject(type: string, data: Uint8Array): string {
  const head = new TextEncoder().encode(`${type} ${data.length}\0`);
  const all = new Uint8Array(head.length + data.length);
  all.set(head);
  all.set(data, head.length);
  return toHex(sha1(all));
}
