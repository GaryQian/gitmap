// The whole pipeline, headless, on the fixture repo: parse → resolve → cluster → settle → model.
import { describe, expect, it } from 'vitest';
import { config } from '../config';
import { createReplica, decodeModel, encodeModel, edgeId } from '../model';
import { createModelStore } from '../model';
import { buildFixtureRepo, fixtureExpected } from '../testing/fixture';
import { runHeadless } from './node';

interface Expected { files: number; imports: [string, string][]; notImports: [string, string][] }

describe('headless pipeline on fixtures/three-lang', () => {
  it('turns a real folder into a settled model with the expected import edges', async () => {
    const rootPath = buildFixtureRepo('three-lang');
    const expected = fixtureExpected<Expected>('three-lang');
    const stages: string[] = [];
    const run = await runHeadless({ kind: 'directory', locator: { kind: 'node', rootPath } }, config, {
      onEvent(evt, payload) { if (evt === 'stage') { const s = (payload as { stage: string }).stage; if (stages.at(-1) !== s) stages.push(s); } },
    });
    try {
      const { model } = run;
      expect(stages).toEqual(['manifest', 'reading', 'structure', 'layout', 'revealed']);
      expect(model.tables.file.ids.length).toBe(expected.files);
      expect(model.meta.name).toBe('three-lang');
      expect(model.meta.headOid).toMatch(/^[0-9a-f]{40}$/);
      const edges = new Set(model.tables.edge.ids);
      for (const [src, dst] of expected.imports) expect(edges.has(edgeId(src, dst)), `${src} → ${dst}`).toBe(true);
      for (const [src, dst] of expected.notImports) expect(edges.has(edgeId(src, dst)), `${src} → ${dst}`).toBe(false);
      // every unit has a district, every district a city, and a finite settled position
      expect(model.tables.unit.cols.district!.every((d) => d !== '')).toBe(true);
      expect(model.layout!.unit.ids.length).toBe(model.tables.unit.ids.length);
      expect(model.layout!.unit.xz.every(Number.isFinite)).toBe(true);
      expect(model.layout!.city.xzr.every(Number.isFinite)).toBe(true);
      // the snapshot round-trips and loads through the same path as any other batch
      const again = await decodeModel(await encodeModel(model));
      const store = createModelStore();
      const replica = createReplica();
      store.subscribe((b) => { expect(replica.apply(b)).toBe(true); });
      store.load(again);
      expect(replica.table('unit').count).toBe(model.tables.unit.ids.length);
      expect(replica.table('edge').count).toBe(model.tables.edge.ids.length);
    } finally {
      run.dispose();
    }
  });
});
