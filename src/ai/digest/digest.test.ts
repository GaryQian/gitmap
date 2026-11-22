import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';
import { config, withConfig } from '../../config';
import type { Config } from '../../config';
import type { FileFacts, SyntaxFacts } from '../../contracts/lang';
import type { ModelReplica } from '../../contracts/store';
import { createReplica } from '../../model';
import { parseRef, unitRef } from '../../model/types';
import type { ColumnChunk, NodeRef, StructureTables } from '../../model/types';
import { syntheticTables, tablesToFullBatch } from '../../testing/synthetic';
import { matcher } from './filters';
import { buildDetailContext, buildDigest, buildDigestText, poiCount } from './index';
import type { DigestInput } from './index';

// ---- a hand-made repository on top of the synthetic clusters ----

const FAKE_AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
const FAKE_TOKEN = 'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwx';
const PRIVATE_KEY_HEADER = '-----BEGIN RSA ' + 'PRIVATE KEY-----';

/** Paths added by hand to district 0 of city 0, each exercising one rule. */
const EXTRA = {
  cli: 'city-0/district-0-0/cli.ts',
  vendored: 'city-0/vendor/leftpad/index.ts',
  generated: 'city-0/district-0-0/schema.generated.ts',
  fixture: 'city-0/district-0-0/fixtures/sample.ts',
  test: 'city-0/district-0-0/widget.test.ts',
  testReadme: 'city-0/tests/README.md',
  env: 'city-0/district-0-0/.env.production',
  leaky: 'city-0/district-0-0/leaky.ts',
  leakyReadme: 'city-1/README.md',
  lockfile: 'package-lock.json',
  manifest: 'package.json',
  readme: 'README.md',
};

function readme(title: string, about: string): string {
  const paragraphs = Array.from({ length: 14 }, (_, i) => `${about} Paragraph ${i} explains how the ${title} pieces fit together and why they were built this way.`);
  return [`# ${title}`, '', '[![build](https://example.test/badge.svg)](https://example.test)', '', paragraphs.slice(0, 5).join('\n\n'), '',
    '## Usage', '', paragraphs.slice(5, 10).join('\n\n'), '', '## Design', '', paragraphs.slice(10).join('\n\n'), ''].join('\n');
}

function addFile(tables: StructureTables, path: string, lang: string, loc: number): void {
  const u = tables.unit, f = tables.file;
  u.ids.push(path);
  u.cols.primaryFile!.push(path);
  u.cols.fileCount!.push(1);
  u.cols.loc!.push(loc);
  u.cols.bytes!.push(loc * 32);
  u.cols.lang!.push(lang);
  u.cols.importancePct!.push(0.5);
  u.cols.fanIn!.push(0);
  u.cols.fanOut!.push(0);
  u.cols.district!.push(tables.district.ids[0]);
  f.ids.push(path);
  f.cols.lang!.push(lang);
  f.cols.bytes!.push(loc * 32);
  f.cols.loc!.push(loc);
  f.cols.oid!.push('');
  f.cols.unit!.push(path);
}

interface Repo { tables: StructureTables; files: FileFacts[]; syntax: SyntaxFacts[] }

function makeRepo(files: number, cities: number, districtsPerCity: number): Repo {
  const tables = syntheticTables({ files, cities, districtsPerCity, seed: 7 });
  for (const path of Object.values(EXTRA)) addFile(tables, path, path.endsWith('.ts') ? 'ts' : 'other', 40);
  // A README at the root of every city and district folder.
  const docs = new Map<string, string>([[EXTRA.readme, readme('Synthetic', 'The root README claims this is a fast and elegant system.')]]);
  for (const c of tables.city.cols.name!) docs.set(`${c}/README.md`, readme(c, `Claims about ${c}.`));
  tables.district.ids.forEach((_, d) => {
    const dir = `${tables.city.cols.name![Math.floor(d / districtsPerCity)]}/${tables.district.cols.name![d]}`;
    docs.set(`${dir}/README.md`, readme(dir, `Claims about ${dir}.`));
  });
  docs.set(EXTRA.testReadme, readme('Tests', 'How to run the TESTONLYMARKER suite.'));
  docs.set(EXTRA.leakyReadme, readme('Leaky', `Deploy with LEAKYDOCMARKER and the key ${FAKE_AWS_KEY}.`));
  for (const path of docs.keys()) if (!tables.file.ids.includes(path)) addFile(tables, path, 'other', 60);

  const excerpts = new Map(docs);
  excerpts.set(EXTRA.manifest, JSON.stringify({ name: 'synthetic-repo', bin: { synth: './city-0/district-0-0/cli.ts' }, scripts: { dev: 'vite', test: 'vitest run' } }));
  excerpts.set(EXTRA.lockfile, JSON.stringify({ name: 'LOCKFILEMARKER', lockfileVersion: 3 }));
  excerpts.set(EXTRA.env, `API_TOKEN=${FAKE_TOKEN}`);

  const factList: FileFacts[] = tables.file.ids.map((path, i) => ({
    path, oid: '', bytes: tables.file.cols.bytes![i], lang: tables.file.cols.lang![i], loc: tables.file.cols.loc![i], imports: [],
    ...(excerpts.has(path) ? { excerpt: excerpts.get(path) } : {}),
  }));
  const syntax: SyntaxFacts[] = tables.file.ids.filter((p) => !p.endsWith('.md') && !p.endsWith('.json')).map((path, i) => ({
    path, oid: '', refs: [],
    defs: Array.from({ length: 6 }, (_, k) => ({
      name: `handle${['Request', 'Batch', 'Frame', 'Token', 'Layout', 'Cache'][k]}${i}`, kind: 'function' as const, line: 10 * k + 1, exported: k < 4,
      signature: `export function handle${['Request', 'Batch', 'Frame', 'Token', 'Layout', 'Cache'][k]}${i}(input: Input${k}, options?: Options): Result${k} {`,
      doc: `Handles step ${k} of file ${i} and returns what the next stage needs.`,
    })),
  }));
  const leaky = syntax.find((s) => s.path === EXTRA.leaky)!;
  leaky.defs[0].signature = `export const API_KEY = "${FAKE_TOKEN}"`;
  leaky.defs[1].doc = `LEAKYCODEMARKER ${PRIVATE_KEY_HEADER}`;
  return { tables, files: factList, syntax };
}

function input(repo: Repo, cfg: Config = config, tables: StructureTables = repo.tables): DigestInput {
  const replica = createReplica();
  replica.apply(tablesToFullBatch(tables));
  return { replica, files: repo.files, syntax: repo.syntax, config: cfg };
}

/** The same model with every table's rows reversed, so every slot differs. */
function reversed(tables: StructureTables): StructureTables {
  const flip = <K extends keyof StructureTables>(chunk: ColumnChunk<K>): ColumnChunk<K> => ({
    ids: [...chunk.ids].reverse(),
    cols: Object.fromEntries(Object.entries(chunk.cols).map(([k, v]) => [k, [...(v as unknown[])].reverse()])) as ColumnChunk<K>['cols'],
  });
  return { city: flip(tables.city), district: flip(tables.district), unit: flip(tables.unit), file: flip(tables.file), edge: flip(tables.edge) };
}

function exists(replica: ModelReplica, ref: NodeRef): boolean {
  const { kind, id } = parseRef(ref);
  return replica.table(kind).has(id);
}

const repo = makeRepo(2000, 8, 6);
// Small enough that all three sections have more material than budget.
const tight = withConfig({ ai: { digestTokens: 9000 } });

describe('digest builder', () => {
  it('splits the budget by config.ai.budgetSplit when every section has more than enough', () => {
    const { tokens, digest } = buildDigestText(input(repo, tight));
    const { digestTokens, budgetSplit } = tight.ai;
    expect(tokens.total).toBeLessThanOrEqual(digestTokens);
    expect(tokens.total).toBeGreaterThan(digestTokens * 0.9);
    for (const section of ['structure', 'skeletons', 'docs'] as const) {
      expect(Math.abs(tokens[section] / digestTokens - budgetSplit[section]), section).toBeLessThan(0.05);
    }
    // Docs carry their label as claims, and every doc line is quoted.
    expect(digest).toMatch(/## Docs \(claims, not measurements\)/);
    expect(digest).toMatch(/may be stale/);
  });

  it('gives byte-identical output for the same model, whatever the slots, and a different sample for another seed', async () => {
    const a = await buildDigest(input(repo, tight));
    const b = await buildDigest(input(repo, tight));
    const c = await buildDigest(input(repo, tight, reversed(repo.tables)));
    expect(b).toEqual(a);
    expect(c.digest).toBe(a.digest);
    expect(c.hash).toBe(a.hash);
    expect(c.cities).toEqual(a.cities);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);

    const other = await buildDigest(input(repo, withConfig({ ai: { digestTokens: tight.ai.digestTokens }, clustering: { seed: config.clustering.seed + 1 } })));
    expect(other.digest).not.toBe(a.digest);
    expect(other.hash).not.toBe(a.hash);
    const files = (refs: NodeRef[]) => refs.filter((r) => r.startsWith('u:'));
    expect(files(other.refs)).not.toEqual(files(a.refs));

    const otherModels = await buildDigest(input(repo, withConfig({ ai: { digestTokens: tight.ai.digestTokens, models: { bulk: 'another-model' } } })));
    expect(otherModels.digest).toBe(a.digest);
    expect(otherModels.hash).not.toBe(a.hash);
  });

  it('never shows excluded, test or secret material, in the digest or in any city context', () => {
    const built = buildDigestText(input(repo));
    const everything = [built.digest, ...built.cities.map((c) => c.context)].join('\n');
    for (const key of ['vendored', 'generated', 'fixture', 'test', 'testReadme', 'env', 'leaky', 'leakyReadme', 'lockfile'] as const) {
      expect(everything.includes(EXTRA[key]), EXTRA[key]).toBe(false);
    }
    for (const marker of ['TESTONLYMARKER', 'LEAKYDOCMARKER', 'LEAKYCODEMARKER', 'LOCKFILEMARKER', FAKE_AWS_KEY, FAKE_TOKEN, PRIVATE_KEY_HEADER]) {
      expect(everything.includes(marker), marker).toBe(false);
    }
    const all = new Set<string>([...built.refs, ...built.cities.flatMap((c) => c.refs)]);
    for (const key of ['vendored', 'generated', 'fixture', 'test', 'env', 'leaky'] as const) expect(all.has(unitRef(EXTRA[key]))).toBe(false);
    // Tests are still counted, and what is shown includes the hand-made entry point and manifest.
    expect(built.digest).toMatch(/\d+ test files/);
    expect(built.digest).toContain(`entry point ${unitRef(EXTRA.cli)}`);
    expect(built.digest).toContain('name "synthetic-repo"');
    expect(built.digest).toContain(`${unitRef(EXTRA.readme)} — claims about the repository as a whole`);

    // A detail button on a withheld file gets no context; text with a key in it is refused too.
    const inp = input(repo);
    expect(buildDetailContext(inp, { parent: unitRef(EXTRA.env) })).toMatchObject({ context: '', withheld: 'secret' });
    expect(buildDetailContext(inp, { parent: unitRef(EXTRA.leaky) })).toMatchObject({ context: '', withheld: 'secret' });
    expect(buildDetailContext(inp, { parent: unitRef(EXTRA.cli) }, { fileText: `const k = "${FAKE_TOKEN}"` }).withheld).toBe('secret');
    expect(buildDetailContext(inp, { parent: unitRef(EXTRA.vendored) }).withheld).toBe('excluded');
  });

  it('matches paths exactly as picomatch does with the configured globs', () => {
    const paths = [
      ...repo.tables.file.ids, 'vendor', 'a/vendor', 'a/vendor/x.ts', 'a/xvendor/y.ts', 'x.min.js', 'a/b/c.min.css', 'yarn.lock', 'a/Cargo.lock',
      'a.lock/x.ts', 'a/b.generated.ts', 'x.pb.go', 'a/x_pb2.py', 'tests/a.py', 'a/test/b.go', 'a/test', 'a/__tests__/b.ts', 'a/b_test.go',
      'a/b.test.tsx', 'a/b.spec.js', 'a/FooTest.java', 'FooTest.java', 'a/test_x.py', 'test_x.py', 'src/latest/contest.ts', 'dist/a.js', 'src/dist/a.js',
      'node_modules/x/y.js', 'a/third_party/z.c', 'a/b.map', 'package-lock.json', 'a/pnpm-lock.yaml', '.env', 'README.md',
    ];
    for (const globs of [config.parser.exclude, config.overlays.tests.patterns]) {
      const expected = picomatch(globs, { dot: true, windows: false });
      const actual = matcher(globs, false);
      for (const path of paths) expect(actual(path), path).toBe(expected(path));
    }
  });

  it('lists exactly refs that exist in the model and appear in the text, within the budget', () => {
    const inp = input(repo);
    const built = buildDigestText(inp);
    expect(built.tokens.total).toBeLessThanOrEqual(config.ai.digestTokens);
    expect(built.refs.length).toBeGreaterThan(0);
    expect([...built.refs].sort()).toEqual(built.refs);
    for (const ref of built.refs) {
      expect(exists(inp.replica, ref), ref).toBe(true);
      expect(built.digest.includes(ref), ref).toBe(true);
    }
    // Every city and district is in a model this small; files are a sample.
    expect(built.refs.filter((r) => r.startsWith('c:')).length).toBe(inp.replica.table('city').count);
    expect(built.refs.filter((r) => r.startsWith('d:')).length).toBe(inp.replica.table('district').count);
    // A file ref at the start of a line is always one the list carries.
    for (const m of built.digest.matchAll(/^\s*(u:\S+) — /gm)) expect(built.refs.includes(m[1] as NodeRef), m[1]).toBe(true);

    // Points of interest stand on files: every city and district names a file that stands for it.
    const standIns = [...built.digest.matchAll(/^\s+stands for it: (u:\S+)/gm)];
    expect(standIns.length).toBe(inp.replica.table('city').count + inp.replica.table('district').count);

    expect(built.cities.length).toBe(inp.replica.table('city').count);
    for (const city of built.cities) {
      expect(city.tokens.total).toBeLessThan(config.ai.digestTokens);
      expect(city.context.includes(city.ref)).toBe(true);
      expect(city.context).toMatch(/stands for it: u:/);
      for (const ref of city.refs) {
        expect(exists(inp.replica, ref), ref).toBe(true);
        expect(city.context.includes(ref), ref).toBe(true);
      }
    }
  });

  it('gives its share to the others when a section has little to say', () => {
    // No syntax facts at all: no skeletons, so structure and docs take the room they can use.
    const bare = buildDigestText({ ...input(repo, tight), syntax: [] });
    expect(bare.digest).toContain('(no signatures are available)');
    expect(bare.tokens.total).toBeLessThanOrEqual(tight.ai.digestTokens);
    const full = buildDigestText(input(repo, tight));
    expect(bare.tokens.structure + bare.tokens.docs).toBeGreaterThan(full.tokens.structure + full.tokens.docs);
  });

  it('builds a detail context with the file, both directions of neighbours, and where it sits', () => {
    const inp = input(repo);
    const units = inp.replica.table('unit');
    // A file with both dependencies and dependents.
    const slot = units.slots().find((s) => units.cols.fanIn[s] >= 2 && units.cols.fanOut[s] >= 2 && /file\d+/.test(units.ids[s]!))!;
    const ref = unitRef(units.ids[slot]!);
    const detail = buildDetailContext(inp, { parent: ref });
    expect(detail.withheld).toBeNull();
    expect(detail.context).toContain(`# File ${ref}`);
    expect(detail.context).toContain('## Depends on');
    expect(detail.context).toContain('## Used by');
    expect(detail.context).toContain('export function handleRequest');
    expect(detail.refs.some((r) => r.startsWith('d:'))).toBe(true);
    expect(detail.refs.some((r) => r.startsWith('c:'))).toBe(true);
    expect(detail.refs.filter((r) => r.startsWith('u:')).length).toBeGreaterThan(2);
    for (const r of detail.refs) {
      expect(exists(inp.replica, r), r).toBe(true);
      expect(detail.context.includes(r), r).toBe(true);
    }
    expect(detail.tokens).toBeLessThan(config.ai.digestTokens);

    const withText = buildDetailContext(inp, { parent: ref }, { fileText: 'export const answer = 42;\n' });
    expect(withText.context).toContain('export const answer = 42;');
    expect(buildDetailContext(inp, { parent: 'u:no/such/file.ts' }).withheld).toBe('unknown');
  });

  it('asks for about one point of interest per city plus a few, capped', () => {
    const { perCity, repoWide, max } = config.ai.pois;
    const small = input(makeRepo(50, 4, 1));
    expect(poiCount(small.replica, config)).toBe(Math.min(max, 4 * perCity + repoWide));
    const big = createReplica();
    big.apply(tablesToFullBatch(syntheticTables({ files: 3000, cities: 20 })));
    expect(poiCount(big, config)).toBe(max);
    expect(poiCount(createReplica(), config)).toBe(0);
  });

  it('builds a 10k-file digest quickly (timing is logged, not asserted)', async () => {
    const large = makeRepo(10000, 12, 8);
    const inp = input(large);
    const started = performance.now();
    const built = await buildDigest(inp);
    const ms = performance.now() - started;
    const t0 = performance.now();
    buildDetailContext(inp, { parent: built.refs.find((r) => r.startsWith('u:'))! });
    const detailMs = performance.now() - t0;
    console.info(`[digest] ${inp.replica.table('unit').count} units, ${inp.replica.table('edge').count} edges: buildDigest ${ms.toFixed(0)} ms ` +
      `(${built.tokens.total} tokens: structure ${built.tokens.structure}, skeletons ${built.tokens.skeletons}, docs ${built.tokens.docs}; ` +
      `${built.refs.length} refs, ${built.cities.length} city contexts), buildDetailContext ${detailMs.toFixed(0)} ms`);
    expect(built.tokens.total).toBeLessThanOrEqual(config.ai.digestTokens);
  });
});
