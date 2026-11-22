// The linker (PLAN.md §6.4.1): a hash join of consumed keys against provided keys. One edge per
// (consumer file, provider file, key), consumer → provider. A key with more than one provider
// produces no edge, and a file never bridges to itself.
import type { EdgeKind } from '../model/types';
import { basename, dirname, extname } from '../shared';
import { protoProvides } from './proto';
import type { BridgeEdge } from './types';

export interface BridgeFile {
  path: string;
  bridge?: { provides?: string[]; consumes?: string[] };
}

/** Key prefix → the mechanism recorded on the edge. An unknown prefix is its own mechanism. */
const MECHANISM_OF_PREFIX: Record<string, string> = { jni: 'jni', jvm: 'jni', proto: 'protobuf' };

function mechanismOf(key: string): string {
  const colon = key.indexOf(':');
  const prefix = colon < 0 ? key : key.slice(0, colon);
  return MECHANISM_OF_PREFIX[prefix] ?? prefix;
}

/**
 * A proto key with its stem folded (lower case, no '_' or '-'), so the camel-cased names some
 * generators derive (FooBarOuterClass, FooBar.pbobjc.h) meet foo_bar.proto. Directories stay exact.
 */
function foldProtoKey(body: string): string {
  const slash = body.lastIndexOf('/');
  const stem = body.slice(slash + 1).toLowerCase().replace(/[_-]/g, '');
  return 'proto:' + body.slice(0, slash + 1) + stem;
}

/**
 * The keys a provided key is indexed under. A .proto file answers to every trailing part of its
 * path ('a/b/foo', 'b/foo', 'foo'), because a stub import names the path from some unknown root.
 */
function providedForms(key: string): string[] {
  if (!key.startsWith('proto:')) return [key];
  const body = key.slice(6);
  const out = [foldProtoKey(body)];
  for (let i = body.indexOf('/'); i >= 0; i = body.indexOf('/', i + 1)) out.push(foldProtoKey(body.slice(i + 1)));
  return out;
}

/**
 * The keys to try for a consumed key, most specific first; the first one that has any provider decides.
 *   jvm:C#m           → jvm:C
 *   proto:a/b/foo     → proto:b/foo → proto:foo   (the last, file name alone, is a loose match)
 */
function consumedForms(key: string): { key: string; loose: boolean }[] {
  if (key.startsWith('proto:')) {
    const body = key.slice(6);
    const out = [{ key: foldProtoKey(body), loose: body.indexOf('/') < 0 }];
    for (let i = body.indexOf('/'); i >= 0; i = body.indexOf('/', i + 1)) {
      const rest = body.slice(i + 1);
      out.push({ key: foldProtoKey(rest), loose: rest.indexOf('/') < 0 });
    }
    return out;
  }
  if (key.startsWith('jvm:')) {
    const hash = key.indexOf('#');
    if (hash >= 0) return [{ key, loose: false }, { key: key.slice(0, hash), loose: false }];
  }
  return [{ key, loose: false }];
}

const JVM_EXTENSIONS = new Set(['java', 'kt', 'scala']);

/**
 * Join consumers to providers. `files` should be every file of the repo, with or without bridge
 * keys, because two kinds of provider are known from the path alone:
 *   - a `.proto` file provides its `proto:` keys whether or not anything recorded them;
 *   - a consumed `jvm:` class nobody provides explicitly is looked up by its conventional path
 *     (`…/com/foo/Bar.java|kt|scala`), so JVM files need not have been scanned to be linked to.
 * Output is sorted by (src, dst, key) and does not depend on the order of `files`.
 */
export function linkBridges(files: readonly BridgeFile[]): BridgeEdge[] {
  const providers = new Map<string, string[]>();
  for (const file of files) {
    const implied = protoProvides(file.path);
    const provides = implied.length ? [...(file.bridge?.provides ?? []), ...implied] : file.bridge?.provides;
    if (!provides) continue;
    for (const provided of provides) {
      for (const form of providedForms(provided)) {
        const list = providers.get(form);
        if (!list) providers.set(form, [file.path]);
        else if (list[list.length - 1] !== file.path) list.push(file.path);
      }
    }
  }

  // JVM source files by class name, built only if a `jvm:` key needs the path fallback.
  let jvmFiles: Map<string, string[]> | undefined;
  const jvmFilesNamed = (stem: string): readonly string[] => {
    if (!jvmFiles) {
      jvmFiles = new Map();
      for (const file of files) {
        const ext = extname(file.path);
        if (!JVM_EXTENSIONS.has(ext)) continue;
        const name = basename(file.path).slice(0, -(ext.length + 1));
        const list = jvmFiles.get(name);
        if (list) list.push(file.path); else jvmFiles.set(name, [file.path]);
      }
    }
    return jvmFiles.get(stem) ?? [];
  };
  /** Files whose path is the conventional home of a class: <package as directories>/<TopLevelClass>.<ext>. */
  const jvmFilesByPath = (key: string): string[] => {
    const hash = key.indexOf('#');
    const binary = key.slice(4, hash < 0 ? key.length : hash);
    const dot = binary.lastIndexOf('.');
    if (dot < 0) return []; // no package: a bare file name is too weak a match
    const dir = binary.slice(0, dot).replace(/\./g, '/');
    const dollar = binary.indexOf('$', dot);
    const top = binary.slice(dot + 1, dollar < 0 ? binary.length : dollar);
    const inPackage = (p: string) => { const d = dirname(p); return d === dir || d.endsWith('/' + dir); };
    const out = jvmFilesNamed(top).filter(inPackage);
    if (out.length === 0 && top.endsWith('Kt') && top.length > 2) {
      // FooKt is the facade class of foo.kt / Foo.kt.
      const stem = top.slice(0, -2);
      const lower = stem[0].toLowerCase() + stem.slice(1);
      const names = lower === stem ? [stem] : [stem, lower];
      for (const n of names) for (const p of jvmFilesNamed(n)) if (extname(p) === 'kt' && inPackage(p)) out.push(p);
    }
    return out;
  };

  const edges: BridgeEdge[] = [];
  for (const file of files) {
    const consumes = file.bridge?.consumes;
    if (!consumes || consumes.length === 0) continue;
    for (const key of new Set(consumes)) {
      let found: readonly string[] | undefined;
      let loose = false;
      for (const form of consumedForms(key)) {
        found = providers.get(form.key);
        if (found) { loose = form.loose; break; }
      }
      if (!found && key.startsWith('jvm:')) {
        const byPath = jvmFilesByPath(key);
        if (byPath.length > 0) { found = byPath; loose = true; }
      }
      // The ambiguity rule: exactly one provider, and not the consumer itself.
      if (!found || found.length !== 1 || found[0] === file.path) continue;
      const edge: BridgeEdge = { src: file.path, dst: found[0], mechanism: mechanismOf(key), key };
      if (loose) edge.loose = true;
      edges.push(edge);
    }
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return edges.sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.key, b.key));
}

/** A file-level relation in the shape of the analysis stage's `RawEdge` (src/analysis/resolve.ts). */
export interface BridgeRawEdge {
  src: string;
  dst: string;
  kind: EdgeKind;
  confidence: number;
  /** Number of distinct keys that link the pair (five native methods → 5). */
  count: number;
  mechanism: string;
}

/**
 * Bridge edges folded to one raw edge per (src, dst, mechanism), ready to append to the analysis
 * stage's raw edges. A pair linked only by loose matches takes `looseConfidence`.
 */
export function bridgeRawEdges(edges: readonly BridgeEdge[], confidence = 1, looseConfidence = confidence): BridgeRawEdge[] {
  const out: BridgeRawEdge[] = [];
  const byPair = new Map<string, BridgeRawEdge>();
  for (const e of edges) {
    const id = e.src + '\t' + e.dst + '\t' + e.mechanism;
    const c = e.loose ? looseConfidence : confidence;
    const raw = byPair.get(id);
    if (raw) { raw.count++; if (c > raw.confidence) raw.confidence = c; continue; }
    const made: BridgeRawEdge = { src: e.src, dst: e.dst, kind: 'bridge', confidence: c, count: 1, mechanism: e.mechanism };
    byPair.set(id, made);
    out.push(made);
  }
  return out;
}
