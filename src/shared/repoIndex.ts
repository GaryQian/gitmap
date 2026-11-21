// The RepoIndex handed to language resolvers (contracts/lang.ts). Built once per analysis run.
import type { FileFacts, RepoIndex } from '../contracts/lang';
import { basename, dirname } from './index';

const EMPTY: readonly string[] = Object.freeze([]);

export function createRepoIndex(files: readonly FileFacts[]): RepoIndex {
  const byPath = new Map<string, FileFacts>();
  const byBase = new Map<string, string[]>();
  const byDir = new Map<string, string[]>();
  const byLang = new Map<string, FileFacts[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (const f of files) {
    byPath.set(f.path, f);
    push(byBase, basename(f.path), f.path);
    push(byDir, dirname(f.path), f.path);
    if (f.lang) push(byLang, f.lang, f);
  }
  const suffixCache = new Map<string, readonly string[]>();
  return {
    files,
    get: (path) => byPath.get(path),
    has: (path) => byPath.has(path),
    byBasename: (name) => byBase.get(name) ?? EMPTY,
    inDir: (dir) => byDir.get(dir) ?? EMPTY,
    byLang: (lang) => byLang.get(lang) ?? [],
    bySuffix(suffix) {
      let hit = suffixCache.get(suffix);
      if (!hit) {
        const tail = '/' + suffix;
        hit = (byBase.get(basename(suffix)) ?? EMPTY).filter((p) => p === suffix || p.endsWith(tail));
        suffixCache.set(suffix, hit);
      }
      return hit;
    },
    text: (path) => byPath.get(path)?.excerpt,
  };
}
