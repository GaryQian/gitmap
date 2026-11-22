// From a file's bytes to what the reader shows: text, the first part of a very large text, or the
// fact that it is not text. Pure, no React.

export type Decoded =
  | { kind: 'binary' }
  | {
      kind: 'text';
      text: string;
      /** Lines in `text`. */
      lines: number;
      /** True when only the first part of the file is in `text`. */
      truncated: boolean;
      totalBytes: number;
      shownBytes: number;
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

export function decodeContent(bytes: Uint8Array, capBytes: number, sniffBytes: number): Decoded {
  if (looksBinary(bytes, sniffBytes)) return { kind: 'binary' };
  const shownBytes = cutPoint(bytes, capBytes);
  // not fatal: a stray byte in an otherwise readable file shows as U+FFFD instead of hiding the file
  const text = new TextDecoder('utf-8').decode(bytes.subarray(0, shownBytes));
  return { kind: 'text', text, lines: countLines(text), truncated: shownBytes < bytes.length, totalBytes: bytes.length, shownBytes };
}

/** "812 bytes", "14 KB", "2 MB", "5.3 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const shown = value >= 10 || Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}
