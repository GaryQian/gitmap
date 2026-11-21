// Stage 1 — resolve imports (PLAN.md §6.4): every ImportSpec of every file is handed to its
// language's resolver; the answers become file-level raw edges.
import type { FileFacts, LanguagePlugin, RepoIndex, Resolver } from '../contracts/lang';
import type { EdgeKind } from '../model/types';
import { plugins as registeredPlugins } from '../lang';
import { createRepoIndex } from '../shared/repoIndex';

/**
 * One file-level relation, before aggregation to units. Stage 1 emits kind 'import'; symbol linking
 * (package 2C) appends 'call' / 'reference' / 'inherit' edges and bridges (3K) append 'bridge'.
 */
export interface RawEdge {
  /** Path of the dependent file (importer, caller). */
  src: string;
  /** Path of the file depended on. */
  dst: string;
  kind: EdgeKind;
  /** 0..1. */
  confidence: number;
  /** Occurrences this edge stands for: import statements, or references to symbols of `dst`. Default 1. */
  count?: number;
  /** For kind 'bridge': 'jni' | 'protobuf' | ... */
  mechanism?: string;
}

export interface ResolveResult {
  edges: RawEdge[];
  /** Import statements seen. */
  importsTotal: number;
  /** Import statements that resolved to at least one other file of the repo. */
  importsResolved: number;
  /** Kept for later stages (symbol linking needs the index and Resolver.scopes). */
  index: RepoIndex;
  resolvers: Map<string, Resolver>;
}

/**
 * `files` must be in path order (see sortFiles). `plugins` defaults to the registry; tests pass fakes.
 * A resolver that throws is treated as "unresolved" for that import.
 */
export function resolveImports(
  files: readonly FileFacts[],
  plugins: readonly LanguagePlugin[] = registeredPlugins,
): ResolveResult {
  const index = createRepoIndex(files);
  const byId = new Map<string, LanguagePlugin>();
  for (const p of plugins) if (!byId.has(p.id)) byId.set(p.id, p);

  // One resolver per language present, created in language order.
  const langs = new Set<string>();
  for (const f of files) if (f.lang) langs.add(f.lang);
  const resolvers = new Map<string, Resolver>();
  for (const lang of [...langs].sort()) {
    const resolver = byId.get(lang)?.createResolver?.(index);
    if (resolver) resolvers.set(lang, resolver);
  }

  const edges: RawEdge[] = [];
  const warned = new Set<string>();
  let importsTotal = 0;
  let importsResolved = 0;
  for (const file of files) {
    const imports = file.imports;
    if (!imports || imports.length === 0) continue;
    importsTotal += imports.length;
    const resolver = file.lang ? resolvers.get(file.lang) : undefined;
    if (!resolver) continue;
    for (const imp of imports) {
      let targets: readonly { path: string; confidence: number }[];
      try {
        targets = resolver.resolve(file, imp) ?? [];
      } catch (err) {
        if (!warned.has(file.lang!)) {
          warned.add(file.lang!);
          console.warn(`analysis: resolver '${file.lang}' threw on ${file.path} (${imp.spec}); import skipped`, err);
        }
        continue;
      }
      const first = edges.length;
      for (const t of targets) {
        if (!t || t.path === file.path || !index.has(t.path)) continue;
        const confidence = clamp01(t.confidence);
        // One statement naming the same file twice is one edge, at the better confidence.
        let dup = -1;
        for (let k = first; k < edges.length; k++) if (edges[k].dst === t.path) { dup = k; break; }
        if (dup >= 0) { if (confidence > edges[dup].confidence) edges[dup].confidence = confidence; continue; }
        edges.push({ src: file.path, dst: t.path, kind: 'import', confidence });
      }
      if (edges.length > first) importsResolved++;
    }
  }
  return { edges, importsTotal, importsResolved, index, resolvers };
}

export function clamp01(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0; // NaN → 0
}
