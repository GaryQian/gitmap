// The three-lang fixture through the whole fast path: manifest → fast pass → resolvers. Every
// import edge in fixtures/three-lang/expected.json must be found, and none of its `notImports`.
import { describe, expect, it } from 'vitest';
import { config } from '../config';
import type { Resolver } from '../contracts/lang';
import { plugins } from '../lang';
import { createRepoIndex } from '../shared/repoIndex';
import { fixtureExpected, fixtureFiles } from '../testing/fixture';
import { createFakePool, memoryRepo } from '../testing/memory';
import fastPassTask from './fastpass.task';
import { buildManifest, runFastPass } from './index';

interface Expected { files: number; imports: [string, string][]; notImports: [string, string][] }

describe('three-lang fixture', () => {
  it('yields the expected import edges', async () => {
    const expected = fixtureExpected<Expected>('three-lang');
    const repo = memoryRepo('three-lang', fixtureFiles('three-lang'));
    const manifest = await buildManifest(repo, config);
    expect(manifest.entries).toHaveLength(expected.files);

    const pool = createFakePool({ config, tasks: [fastPassTask], repo });
    const facts = await runFastPass(manifest, pool, config);
    const index = createRepoIndex(facts);
    const resolvers = new Map<string, Resolver>();
    for (const p of plugins) { const r = p.createResolver?.(index); if (r) resolvers.set(p.id, r); }

    const edges = new Set<string>();
    for (const f of facts) {
      const resolver = f.lang ? resolvers.get(f.lang) : undefined;
      if (!resolver) continue;
      for (const imp of f.imports) for (const hit of resolver.resolve(f, imp)) {
        expect(index.has(hit.path)).toBe(true);
        expect(hit.confidence).toBeGreaterThan(0);
        edges.add(`${f.path} -> ${hit.path}`);
      }
    }
    for (const [from, to] of expected.imports) expect(edges, `${from} -> ${to}`).toContain(`${from} -> ${to}`);
    for (const [from, to] of expected.notImports) expect(edges).not.toContain(`${from} -> ${to}`);
    // nothing else resolves in this fixture: system headers, `sys`, and commented-out imports stay out
    expect(edges.size).toBe(expected.imports.length);
  });
});
