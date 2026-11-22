// From a file's bytes to what the reader shows: text, the first part of a very large text, or the
// fact that it is not text. Pure, no React.
import { extname } from '../../shared';

export type Decoded =
  | { kind: 'binary' }
  | { kind: 'image'; bytes: Uint8Array; mime: string }
  | {
      kind: 'text';
      text: string;
      /** Lines in `text`. */
      lines: number;
      /** True when only the first part of the file is in `text`. */
      truncated: boolean;
      totalBytes: number;
      shownBytes: number;
      /** The file starts with a UTF-8 byte order mark (dropped from `text`, put back on save). */
      bom: boolean;
      /** Some bytes were not valid UTF-8 and show as U+FFFD: saving would change them. */
      lossy: boolean;
    };

/** A NUL byte in the first `sniffBytes` is how git, and this reader, tell binary from text. */
export function looksBinary(bytes: Uint8Array, sniffBytes: number): boolean {
  const end = Math.min(bytes.length, sniffBytes);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Where to cut a file that is over the cap: after the last whole line that fits, or, when one line
 * fills the cap, at the cap without splitting a UTF-8 sequence.
 */
export function cutPoint(bytes: Uint8Array, capBytes: number): number {
  if (bytes.length <= capBytes) return bytes.length;
  for (let i = capBytes - 1; i >= 0; i--) if (bytes[i] === 0x0a) return i + 1;
  let cut = capBytes;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return cut;
}

export function countLines(text: string): number {
  if (text === '') return 0;
  let lines = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
  return text.endsWith('\n') ? lines - 1 : lines;
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
};

/** The MIME type a browser shows a file as, by extension; null for a file that is not an image. */
export function imageMime(path: string): string | null {
  return IMAGE_MIME[extname(path)] ?? null;
}

export function decodeFile(path: string, bytes: Uint8Array, capBytes: number, sniffBytes: number): Decoded {
  const mime = imageMime(path);
  return mime ? { kind: 'image', bytes, mime } : decodeContent(bytes, capBytes, sniffBytes);
}

export function decodeContent(bytes: Uint8Array, capBytes: number, sniffBytes: number): Decoded {
  if (looksBinary(bytes, sniffBytes)) return { kind: 'binary' };
  const shownBytes = cutPoint(bytes, capBytes);
  // not fatal: a stray byte in an otherwise readable file shows as U+FFFD instead of hiding the file
  const shown = bytes.subarray(0, shownBytes);
  const text = new TextDecoder('utf-8').decode(shown);
  let lossy = false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(shown); } catch { lossy = true; }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return { kind: 'text', text, lines: countLines(text), truncated: shownBytes < bytes.length, totalBytes: bytes.length, shownBytes, bom, lossy };
}

export { formatBytes } from '../units';

/** Text back to the bytes a save writes, with the byte order mark the file had. */
export function encodeContent(text: string, bom: boolean): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}
