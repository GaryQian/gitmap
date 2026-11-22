// The whole pipeline, headless, on the fixture repo: parse → resolve → cluster → settle → model.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAiClient } from '../ai';
import { config } from '../config';
import type { Notice } from '../contracts/pipeline';
import { createReplica, decodeModel, encodeModel, edgeId } from '../model';
import { createModelStore } from '../model';
import type { RepoModel } from '../model/types';
import { TESTS } from '../overlays';
import { IMAGE_LANG } from '../shared';
import { buildFixtureRepo, fixtureExpected, git, projectRoot } from '../testing/fixture';
import { settleDetails } from './ai';
import { memoryPersistence, runHeadless } from './node';

interface Expected {
  files: number; imports: [string, string][]; notImports: [string, string][];
  history: { perFile: Record<string, { lastDate: string }> };
}

/**
 * A private copy of the fixture repo, put back to its last commit: a variant is rebuilt only when
 * the fixture's inputs change, so an earlier run's edits are still there.
 */
function cleanFixture(variant: string): string {
  const dir = buildFixtureRepo('three-lang', variant);
  // Never let git look for a repository above the copy: these commands rewrite the working tree.
  if (!existsSync(path.join(dir, '.git'))) throw new Error(`no fixture repo at ${dir}`);
  const env = { GIT_CEILING_DIRECTORIES: path.dirname(dir) };
  git(dir, ['reset', '-q', '--hard', 'HEAD'], env);
  git(dir, ['clean', '-fdq'], env);
  return dir;
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
      model.tables.unit.cols.lang!.forEach((lang, u) => { if (lang !== 'other' && lang !== IMAGE_LANG) expect(tests.values[u], model.tables.unit.ids[u]).not.toBeNull(); });
      const logo = model.tables.unit.ids.indexOf('web/logo.png');
      expect(model.tables.unit.cols.lang![logo]).toBe(IMAGE_LANG);
      expect(tests.values[logo]).toBeNull();
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
    const rootPath = cleanFixture('return-visit');
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
    expect(third.notices.filter((n) => n.kind === 'files-changed')).toEqual([{ kind: 'files-changed', count: 1 }]);

    // One more file edited on disk and not staged: the working-tree check after the reveal finds it.
    appendFileSync(path.join(rootPath, 'service/db.py'), '\n# edited on disk\n');
    const fourth = await visit();
    expect(fourth.run.state.fromSnapshot).toBe(true);
    expect(fourth.run.state.workingTree?.map((c) => c.path)).toEqual(['service/db.py']);
    expect(fourth.notices.filter((n) => n.kind === 'files-changed').at(-1)).toEqual({ kind: 'files-changed', count: 2 });
  });

  it('applies an Update: the changed file is re-parsed and placed, and nothing else moves district', async () => {
    const rootPath = cleanFixture('update-wire');
    const notices: Notice[] = [];
    const run = await runHeadless({ kind: 'directory', locator: { kind: 'node', rootPath } }, config, {
      onEvent(evt, payload) { if (evt === 'notice') notices.push(payload as Notice); },
    });
    try {
      const before = run.model;
      const types = 'web/src/api/types.ts', format = 'web/src/util/format.ts';
      const unitOf = (model: RepoModel, file: string) => model.tables.file.cols.unit![model.tables.file.ids.indexOf(file)];
      const newEdge = edgeId(unitOf(before, types), unitOf(before, format));
      expect(before.tables.edge.ids).not.toContain(newEdge);
      const locOf = (model: RepoModel, file: string) => model.tables.file.cols.loc![model.tables.file.ids.indexOf(file)];

      // a new import, staged: one more line in types.ts and an edge that was not there
      appendFileSync(path.join(rootPath, types), "import { nothing } from '../util/format';\n");
      git(rootPath, ['add', '--', types]);
      const after = await run.update();

      expect(after.tables.edge.ids).toContain(newEdge);
      expect(locOf(after, types)).toBe(locOf(before, types) + 1);
      expect(after.meta.indexChecksum).not.toBe(before.meta.indexChecksum);
      expect(after.tables.file.ids).toEqual(before.tables.file.ids);
      // an Update places, it does not re-cluster: every unit is in the district it was in
      const districtOf = (model: RepoModel) => new Map(model.tables.unit.ids.map((id, i) => [id, model.tables.unit.cols.district![i]]));
      const was = districtOf(before), now = districtOf(after);
      for (const [unit, district] of was) if (!unit.startsWith('web/')) expect(now.get(unit), unit).toBe(district);
      expect(after.layout!.unit.xz.every(Number.isFinite)).toBe(true);
      expect(notices).toContainEqual({ kind: 'cleared', which: 'files-changed' });
      expect(run.state.changedFiles).toBe(0);
      // the layers follow the structure: still one Tests value per unit, history still complete
      expect(after.layers.tests.values.length).toBe(after.tables.unit.ids.length);
      expect(after.layers.recency.status).toBe('complete');
    } finally {
      run.dispose();
    }
  });
});

/**
 * An AI client with no server behind it: `fetch` answers each route from what the request allows,
 * the way the handlers would with a scripted provider. `sent` lists the routes asked.
 */
function cannedAi(hold?: { route: string; gate: Promise<void> }) {
  const sent: string[] = [];
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url).split('/').pop()!;
    sent.push(route);
    // a request that stays out until the test lets it go, or until it is aborted
    if (hold && route === hold.route) {
      await Promise.race([hold.gate, new Promise<void>((_, reject) => {
        init!.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })]);
    }
    const body = JSON.parse(String(init!.body)) as { city?: string; refs: string[]; count?: number; minSteps?: number };
    const files = body.refs.filter((r) => r.startsWith('u:'));
    const answer =
      route === 'summaries' ? { summary: { parent: body.city, label: 'Core services', text: words(30) } }
      : route === 'pois' ? { pois: Array.from({ length: body.count! }, (_, i) => ({ parent: files[i % files.length], label: `Point ${i}`, summary: words(30), kind: 'core', evidence: 'Many files import it.', refs: [] })) }
      : route === 'tour' ? { steps: Array.from({ length: body.minSteps! }, (_, i) => ({ parent: files[i % files.length], frame: i === 0 ? 'city' : 'file', text: words(20), highlights: files.slice(0, 2) })) }
      : { markdown: 'It **routes** requests.' };
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { client: createAiClient({ fetch, sleep: async () => {} }), sent };
}

describe('AI annotations through the pipeline (no network)', () => {
  const rootPath = () => buildFixtureRepo('three-lang');
  const open = async (persist: Awaited<ReturnType<typeof memoryPersistence>>, ai: ReturnType<typeof cannedAi>) =>
    runHeadless({ kind: 'directory', locator: { kind: 'node', rootPath: rootPath() } }, config, { persist, aiClient: ai.client });

  it('writes summaries, points of interest and a tour when asked, and keeps them on the return visit', async () => {
    const persist = await memoryPersistence();
    const ai = cannedAi();
    const first = await open(persist, ai);
    try {
      // nothing is generated until the viewer has agreed and the chrome calls start
      expect(first.model.annotations).toEqual({ pois: [], tours: [], summaries: [] });
      expect(ai.sent).toEqual([]);
      expect(await first.ai.start()).toEqual({ failure: null });
      const model = await first.finish();
      expect(model.annotations.summaries.length).toBe(model.tables.city.ids.length);
      expect(model.annotations.pois.length).toBeGreaterThan(0);
      expect(model.annotations.tours.length).toBe(1);
      expect(model.meta.digestHash).toBeTruthy();
      expect(new Set(ai.sent)).toEqual(new Set(['summaries', 'pois', 'tour']));

      // a detail button: the answer lands on the point of interest
      const poi = model.annotations.pois[0];
      expect(await first.ai.detail(poi.id, 'role', null)).toEqual({ failure: null });
      const answered = (await first.finish()).annotations.pois.find((p) => p.id === poi.id)!;
      expect(answered.details.role).toMatchObject({ status: 'ready', markdown: 'It **routes** requests.' });
    } finally {
      first.dispose();
    }

    // The return visit shows the saved map and holds no parse facts: the stored notes stay, and
    // nothing is asked for again (a digest built without the facts would replace them with worse).
    const asked = ai.sent.length;
    const second = await open(persist, ai);
    try {
      expect(second.state.fromSnapshot).toBe(true);
      expect(second.model.annotations.tours.length).toBe(1);
      expect(await second.ai.start()).toEqual({ failure: null });
      expect(ai.sent.length).toBe(asked);
      expect((await second.finish()).annotations).toEqual(second.model.annotations);
    } finally {
      second.dispose();
    }
  });

  it('reads the facts again and writes the notes on a return visit that has none stored', async () => {
    // The usual case: the repo was parsed before AI notes were allowed, so the map comes back from
    // its snapshot with no parse facts in memory. The folder is still there, so they are re-read.
    const persist = await memoryPersistence();
    const ai = cannedAi();
    (await open(persist, ai)).dispose();
    const second = await open(persist, ai);
    try {
      expect(second.state.fromSnapshot).toBe(true);
      expect(second.state.facts).toEqual([]);
      const { failure } = await second.ai.start();
      expect(failure).toBeNull();
      expect(ai.sent.length).toBeGreaterThan(0);
      const kinds = new Set(second.store.replica.annotations.map((x) => x.type));
      expect(kinds.has('summary') && kinds.has('poi') && kinds.has('tour')).toBe(true);
      // the facts used for the notes stay out of the update flow's view of what is parsed
      expect(second.state.facts).toEqual([]);
    } finally {
      second.dispose();
    }
  });

  it('cancel aborts the run in flight, keeps what has landed and asks for nothing more', async () => {
    let release = () => {};
    const ai = cannedAi({ route: 'pois', gate: new Promise<void>((resolve) => { release = resolve; }) });
    const run = await runHeadless({ kind: 'directory', locator: { kind: 'node', rootPath: rootPath() } }, config, { aiClient: ai.client });
    try {
      const started = run.ai.start();
      // the summaries are in and the points-of-interest request is out
      for (let i = 0; i < 200 && !ai.sent.includes('pois'); i++) await new Promise((r) => setTimeout(r, 10));
      expect(ai.sent).toContain('pois');
      run.ai.cancel();
      expect(await started).toEqual({ failure: null });
      const asked = ai.sent.length;
      release();
      await new Promise((r) => setTimeout(r, 50));
      expect(ai.sent.length).toBe(asked);
      const kinds = new Set(run.store.replica.annotations.map((a) => a.type));
      expect(kinds.has('summary')).toBe(true);
      expect(kinds.has('poi')).toBe(false);
    } finally {
      run.dispose();
    }
  });

  it('never stores a detail as still loading', () => {
    const model = { annotations: { pois: [{ id: 'p', details: { role: { status: 'loading' }, users: { status: 'ready', markdown: 'x' } } }], tours: [], summaries: [] } } as unknown as RepoModel;
    expect(settleDetails(model).annotations.pois[0].details).toEqual({ role: { status: 'idle' }, users: { status: 'ready', markdown: 'x' } });
    expect(model.annotations.pois[0].details.role.status).toBe('loading'); // the live model is not touched
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
