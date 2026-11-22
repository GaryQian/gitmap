// Fast-pass facts for one file (PLAN.md §6.3): binary check, line count, the plug-in's import scan,
// and the excerpt kept for manifests and docs. Runs inside the fast-pass task.
import picomatch from 'picomatch';
import { BRIDGE_TRIGGERS, extractBridgeKeys, type BridgeKeys } from '../bridges';
import type { Config } from '../config';
import type { ManifestEntry } from '../contracts/ingest';
import type { FileFacts, LanguagePlugin, ScanResult } from '../contracts/lang';
import { isManifestFile, pluginById } from '../lang';
import { now } from '../shared';

/** A NUL byte this early in a file marks it as binary. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * Docs whose opening text is kept for the AI digest: README / ARCHITECTURE / CONTRIBUTING in any
 * folder, the index page of each docs folder, and Markdown files at the repo root.
 */
const DOC_GLOBS = ['**/README*', '**/ARCHITECTURE*', '**/CONTRIBUTING*', '**/docs/**/index.*', '*.md'];
const isDoc = picomatch(DOC_GLOBS, { dot: true, nocase: true, windows: false });

export type ExcerptKind = 'manifest' | 'doc' | null;
/** Whether a file's text is kept: in full for a plug-in's manifest files, the first part for docs. */
export function excerptKind(path: string): ExcerptKind {
  return isManifestFile(path) ? 'manifest' : isDoc(path) ? 'doc' : null;
}

export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Lines in a file: newline count, plus one for a last line without a newline. */
export function countLines(bytes: Uint8Array): number {
  const n = bytes.length;
  if (n === 0) return 0;
  let lines = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 10) lines++;
  return bytes[n - 1] === 10 ? lines : lines + 1;
}

/** Facts for a file that was not scanned. It still gets a sphere, sized from `bytes`. */
export function skippedFacts(entry: ManifestEntry, skipped: NonNullable<FileFacts['skipped']>): FileFacts {
  return { path: entry.path, oid: entry.oid, bytes: entry.bytes, lang: entry.lang, loc: 0, imports: [], skipped };
}

const decoder = new TextDecoder('utf-8');

/** Trigger words of the enabled bridge mechanisms (PLAN.md §6.4.1), per `config.parser.bridges` list. */
const triggerWords = new WeakMap<readonly string[], string[]>();
function bridgeTriggers(enabled: readonly string[]): string[] {
  let words = triggerWords.get(enabled);
  if (!words) {
    const known = BRIDGE_TRIGGERS as Record<string, string[] | undefined>;
    words = [...new Set(enabled.flatMap((mechanism) => known[mechanism] ?? []))];
    triggerWords.set(enabled, words);
  }
  return words;
}

/**
 * Bridge keys of one file, extracted only when a trigger word of an enabled mechanism is in the
 * text. Undefined when the file has none: most files stop at the sweep.
 */
function bridgeKeys(path: string, lang: string | null, text: string, imports: FileFacts['imports'], enabled: readonly string[]): BridgeKeys | undefined {
  if (enabled.length === 0) return undefined;
  const words = bridgeTriggers(enabled);
  let hit = false;
  for (let i = 0; i < words.length && !hit; i++) hit = text.includes(words[i]);
  if (!hit) return undefined;
  const keys = extractBridgeKeys({ path, lang, text, imports }, enabled);
  return keys.provides.length || keys.consumes.length ? keys : undefined;
}

/**
 * Facts for one file from its bytes. Never throws: a scanner that throws yields a file with no
 * imports, and a file that took longer than reveal.perFileTimeoutMs is marked 'timeout' and its
 * imports dropped (a scan cannot be interrupted, only disowned).
 */
export function factsFromBytes(entry: ManifestEntry, bytes: Uint8Array, config: Config, lookup: (id: string) => LanguagePlugin | undefined = pluginById): FileFacts {
  if (looksBinary(bytes)) return { ...skippedFacts(entry, 'binary'), bytes: bytes.length };
  const started = now();
  const text = decoder.decode(bytes);
  const facts: FileFacts = { path: entry.path, oid: entry.oid, bytes: bytes.length, lang: entry.lang, loc: countLines(bytes), imports: [] };
  const plugin = entry.lang ? lookup(entry.lang) : undefined;
  if (plugin) {
    let scan: ScanResult | null = null;
    try { scan = plugin.scan(text, entry.path); } catch { /* the file keeps its sphere, without imports */ }
    if (scan) {
      facts.imports = scan.imports ?? [];
      if (scan.decls) facts.decls = scan.decls;
      if (scan.bridge) facts.bridge = scan.bridge;
    }
  }
  // Cross-language bridges are found here, at the seam, for every language at once: the plug-ins
  // scan imports, and src/bridges reads the same text for JNI names and generated-stub imports.
  const bridge = bridgeKeys(entry.path, entry.lang, text, facts.imports, config.parser.bridges);
  if (bridge) {
    facts.bridge = facts.bridge
      ? { provides: [...new Set([...(facts.bridge.provides ?? []), ...bridge.provides])], consumes: [...new Set([...(facts.bridge.consumes ?? []), ...bridge.consumes])] }
      : bridge;
  }
  if (now() - started > config.reveal.perFileTimeoutMs) return { ...skippedFacts(entry, 'timeout'), bytes: bytes.length };
  const kind = excerptKind(entry.path);
  if (kind === 'manifest') facts.excerpt = text.length > config.parser.maxFileBytes ? text.slice(0, config.parser.maxFileBytes) : text;
  else if (kind === 'doc') facts.excerpt = text.slice(0, config.parser.excerptBytes);
  return facts;
}
