// The whole pipeline, headless, on the fixture repo: parse → resolve → cluster → settle → model.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../config';
import type { Notice } from '../contracts/pipeline';
import { createReplica, decodeModel, encodeModel, edgeId } from '../model';
import { createModelStore } from '../model';
import type { RepoModel } from '../model/types';
import { TESTS } from '../overlays';
import { buildFixtureRepo, fixtureExpected, git, projectRoot } from '../testing/fixture';
import { memoryPersistence, runHeadless } from './node';

interface Expected {
  files: number; imports: [string, string][]; notImports: [string, string][];
  history: { perFile: Record<string, { lastDate: string }> };
}

/** A layer's value for the unit a file belongs to (null = unknown). */
function layerValue(model: RepoModel, layer: string, file: string): number | null {
  const unit = model.tables.file.cols.unit![model.tables.file.ids.indexOf(file)];
  return model.layers[layer].values[model.tables.unit.ids.indexOf(unit)];
}

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
      // Edges join units, and a header shares a unit with its implementation: map files to units first.
      const unitOf = new Map(model.tables.file.ids.map((id, i) => [id, model.tables.file.cols.unit![i]]));
      const edges = new Set(model.tables.edge.ids);
      for (const [src, dst] of expected.imports) {
        const a = unitOf.get(src)!, b = unitOf.get(dst)!;
        if (a !== b) expect(edges.has(edgeId(a, b)), `${src} → ${dst}`).toBe(true);
      }
      for (const [src, dst] of expected.notImports) expect(edges.has(edgeId(unitOf.get(src) ?? src, unitOf.get(dst) ?? dst)), `${src} → ${dst}`).toBe(false);
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

      // the Tests overlay arrives with the structure: one value per unit, known for every code unit
      const tests = model.layers.tests;
      expect(tests.status).toBe('complete');
      expect(tests.values.length).toBe(model.tables.unit.ids.length);
      model.tables.unit.cols.lang!.forEach((lang, u) => { if (lang !== 'other') expect(tests.values[u], model.tables.unit.ids[u]).not.toBeNull(); });
      expect(layerValue(model, 'tests', 'service/tests/test_models.py')).toBe(TESTS.test);
      expect(layerValue(model, 'tests', 'service/models.py')).toBe(TESTS.covered);

      // the history walk is waited for, and its layers are complete
      for (const id of ['recency', 'ownership', 'knowledgeRisk']) expect(model.layers[id]?.status, id).toBe('complete');
      const dates = expected.history.perFile;
      expect(Date.parse(dates['web/src/util/format.ts'].lastDate)).toBeGreaterThan(Date.parse(dates['native/main.c'].lastDate));
      expect(layerValue(model, 'recency', 'web/src/util/format.ts')!).toBeGreaterThan(layerValue(model, 'recency', 'native/main.c')!);
      expect(model.tables.contributor.cols.name).toContain('Ada Lovelace');
      expect(model.meta.history?.complete).toBe(true);

      // search runs on the same index the app's Session.search asks
      expect(run.search('format')[0]).toMatchObject({ ref: 'u:web/src/util/format.ts', path: 'web/src/util/format.ts' });
    } finally {
      run.dispose();
    }
  });

  it('comes back from the stored snapshot on a second visit, and counts what changed since', async () => {
    // its own copy of the fixture: this test stages an edit
    const rootPath = buildFixtureRepo('three-lang', 'return-visit');
    const source = { kind: 'directory', locator: { kind: 'node', rootPath } } as const;
    const persist = await memoryPersistence();
    const visit = async () => {
      const stages: string[] = [];
      const notices: Notice[] = [];
      const run = await runHeadless(source, config, {
        persist,
        onEvent(evt, payload) {
          if (evt === 'stage') stages.push((payload as { stage: string }).stage);
          else if (evt === 'notice') notices.push(payload as Notice);
        },
      });
      run.dispose();
      return { run, stages, notices };
    };

    const first = await visit();
    expect(first.run.state.fromSnapshot).toBe(false);
    expect(first.stages).toContain('reading');
    expect((await persist.registry.list()).map((r) => r.name)).toEqual([first.run.model.meta.name]);

    const second = await visit();
    expect(second.run.state.fromSnapshot).toBe(true);
    expect(second.stages).not.toContain('reading');
    expect(second.run.model.tables).toEqual(first.run.model.tables);
    expect(second.run.model.layers.recency.status).toBe('complete');
    expect(second.notices.filter((n) => n.kind === 'files-changed')).toEqual([]);

    // One file staged with new content: the saved map still loads untouched, and the change is counted.
    writeFileSync(path.join(rootPath, 'docs/notes.txt'), `edited ${Date.now()} ${Math.random()}\n`);
    git(rootPath, ['add', '--', 'docs/notes.txt']);
    const third = await visit();
    expect(third.run.state.fromSnapshot).toBe(true);
    expect(third.run.model.tables).toEqual(first.run.model.tables);
    expect(third.notices).toContainEqual({ kind: 'files-changed', count: 1 });
  });
});

describe('headless pipeline on fixtures/bridges/jni', () => {
  it('joins a Java native method and its Java_… C function into one bridge edge', async () => {
    // a plain folder (no .git): the real JVM and C-family scanners, then src/bridges at the seam
    const rootPath = path.join(projectRoot(), 'fixtures', 'bridges', 'jni', 'repo');
    const run = await runHeadless({ kind: 'directory', locator: { kind: 'node', rootPath } }, config);
    try {
      const edge = run.model.tables.edge;
      const at = edge.ids.indexOf(edgeId('app/src/main/java/com/example/media/Decoder.java', 'native/decoder_jni.cpp'));
      expect(at).toBeGreaterThanOrEqual(0);
      expect([edge.cols.kind![at], edge.cols.mechanism![at]]).toEqual(['bridge', 'jni']);
      expect(run.state.analysis!.diagnostics.bridges).toBeGreaterThan(0);
      // a folder without git has no history to walk, and says so once
      expect(run.state.history).toBeNull();
    } finally {
      run.dispose();
    }
  });
});
