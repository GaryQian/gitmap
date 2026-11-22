// End to end on fixtures/three-lang with the real plug-ins: manifest → fast pass → slow pass →
// analyze. Every call in expected.json must come out as an edge that names the symbol.
import { describe, expect, it } from 'vitest';
import { collectTasks } from '../../compute';
import { config } from '../../config';
import { buildManifest, runFastPass, runSlowPass } from '../../ingest';
import { edgeId } from '../../model';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import { createFakePool, memoryRepo } from '../../testing/memory';
import { analyze } from '../index';

const tasks = collectTasks(import.meta.glob('../../ingest/**/*.task.ts', { eager: true }));

describe('three-lang fixture, slow pass included', () => {
  it('turns the expected calls into edges between units', async () => {
    const expected = fixtureExpected<{ calls: [string, string, string][]; headerPairs: [string, string][] }>('three-lang');
    const repo = memoryRepo('three-lang', fixtureFiles('three-lang'));
    const manifest = await buildManifest(repo, config);
    const pool = createFakePool({ config, tasks, repo });
    const files = await runFastPass(manifest, pool, config);
    const syntax = await runSlowPass(manifest, pool, config);

    const result = analyze({ repoName: 'three-lang', files, syntax, syntaxComplete: true }, config);
    const { edge, file } = result.tables;
    const unitOf = (path: string) => file.cols.unit![file.ids.indexOf(path)];
    for (const [header, impl] of expected.headerPairs) expect(unitOf(header)).toBe(impl);
    for (const [from, to, name] of expected.calls) {
      const e = edge.ids.indexOf(edgeId(unitOf(from), unitOf(to)));
      expect(e, `${from} → ${to}`).toBeGreaterThanOrEqual(0);
      expect(edge.cols.kind![e], `${from} → ${to}`).not.toBe('import');
      expect(edge.cols.symbols![e].split('|').map((s) => s.slice(0, s.lastIndexOf(':'))), `${from} → ${to}`).toContain(name);
    }
    expect(result.structure).toBe('full');
    expect(result.diagnostics.refsLinked).toBeGreaterThan(0);
  }, 60000);
});
