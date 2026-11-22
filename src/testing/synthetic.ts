// Synthetic clustered model generator (seeded, deterministic), after spikes/physics/graph.ts.
// Produces the same StructureTables shape that analysis produces, plus helpers to turn tables into
// an applied full batch without a store.
import { mulberry32 } from '../shared';
import { ENTITY_KINDS, edgeId, type ColumnChunk, type EntityKind, type ModelPatch, type PatchBatch, type RepoMeta, type StructureTables } from '../model/types';

export interface SyntheticOptions {
  files: number;
  cities?: number;
  districtsPerCity?: number;
  edgesPerFile?: number;
  seed?: number;
  langs?: string[];
}

const DEFAULT_LANGS = ['ts', 'js', 'python', 'cpp', 'c', 'go', 'rust', 'java'];

/** A plausible repo: skewed file sizes, edges mostly inside a district, some inside a city, few across. */
export function syntheticTables(opts: SyntheticOptions): StructureTables {
  const rnd = mulberry32(opts.seed ?? 1);
  const n = opts.files;
  const nCities = Math.max(1, opts.cities ?? Math.min(12, Math.max(1, Math.round(3.5 * Math.log10(Math.max(10, n)) - 2.2))));
  const dpc = Math.max(1, opts.districtsPerCity ?? Math.min(8, Math.max(1, Math.round(n / nCities / 25))));
  const epf = opts.edgesPerFile ?? 3;
  const langs = opts.langs ?? DEFAULT_LANGS;
  const gauss = () => { const u = 1 - rnd(), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  const cities: ColumnChunk<'city'> = { ids: [], cols: { name: [] } };
  const districts: ColumnChunk<'district'> = { ids: [], cols: { city: [], name: [] } };
  const districtLang: string[] = [];
  const districtWeight: number[] = [];
  for (let c = 0; c < nCities; c++) {
    cities.ids.push(`c${c}`);
    cities.cols.name!.push(`city-${c}`);
    for (let k = 0; k < dpc; k++) {
      districts.ids.push(`d${c}_${k}`);
      districts.cols.city!.push(`c${c}`);
      districts.cols.name!.push(`district-${c}-${k}`);
      districtLang.push(langs[Math.floor(rnd() * langs.length)]);
      districtWeight.push(Math.exp(gauss() * 0.7));
    }
  }
  const nD = districts.ids.length;
  const cdf: number[] = [];
  let sum = 0;
  for (const w of districtWeight) { sum += w; cdf.push(sum); }
  const pickDistrict = () => {
    const x = rnd() * sum;
    let lo = 0, hi = nD - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < x) lo = m + 1; else hi = m; }
    return lo;
  };

  const units: ColumnChunk<'unit'> = { ids: [], cols: { primaryFile: [], fileCount: [], loc: [], bytes: [], lang: [], importancePct: [], fanIn: [], fanOut: [], district: [] } };
  const files: ColumnChunk<'file'> = { ids: [], cols: { lang: [], bytes: [], loc: [], oid: [], unit: [] } };
  const unitDistrict: number[] = [];
  const members: number[][] = Array.from({ length: nD }, () => []);
  const ext: Record<string, string> = { ts: 'ts', js: 'js', python: 'py', cpp: 'cc', c: 'c', go: 'go', rust: 'rs', java: 'java' };
  for (let i = 0; i < n; i++) {
    // every district gets at least one file while there are files to give
    const d = i < nD ? i : pickDistrict();
    const lang = rnd() < 0.8 ? districtLang[d] : langs[Math.floor(rnd() * langs.length)];
    const loc = Math.round(Math.min(20000, Math.max(3, Math.exp(4.6 + 1.1 * gauss()))));
    const path = `${cities.cols.name![Math.floor(d / dpc)]}/${districts.cols.name![d]}/file${i}.${ext[lang] ?? 'txt'}`;
    units.ids.push(path);
    units.cols.primaryFile!.push(path);
    units.cols.fileCount!.push(1);
    units.cols.loc!.push(loc);
    units.cols.bytes!.push(loc * 32);
    units.cols.lang!.push(lang);
    units.cols.importancePct!.push(0);
    units.cols.fanIn!.push(0);
    units.cols.fanOut!.push(0);
    units.cols.district!.push(districts.ids[d]);
    files.ids.push(path);
    files.cols.lang!.push(lang);
    files.cols.bytes!.push(loc * 32);
    files.cols.loc!.push(loc);
    files.cols.oid!.push('');
    files.cols.unit!.push(path);
    unitDistrict.push(d);
    members[d].push(i);
  }

  const edges: ColumnChunk<'edge'> = { ids: [], cols: { src: [], dst: [], kind: [], weight: [], confidence: [], mechanism: [], symbols: [] } };
  const seen = new Set<string>();
  const attract = Array.from({ length: n }, () => Math.exp(1.3 * gauss()));
  const tournament = (pool: number[] | null) => {
    const pick = () => (pool ? pool[Math.floor(rnd() * pool.length)] : Math.floor(rnd() * n));
    let best = pick();
    for (let k = 0; k < 2; k++) { const c = pick(); if (attract[c] > attract[best]) best = c; }
    return best;
  };
  const cityMembers: number[][] = Array.from({ length: nCities }, () => []);
  for (let i = 0; i < n; i++) cityMembers[Math.floor(unitDistrict[i] / dpc)].push(i);
  for (let i = 0; i < n; i++) {
    const count = Math.max(0, Math.round(epf + gauss()));
    for (let k = 0; k < count; k++) {
      const r = rnd();
      const d = unitDistrict[i];
      const j = r < 0.65 ? tournament(members[d]) : r < 0.9 ? tournament(cityMembers[Math.floor(d / dpc)]) : tournament(null);
      if (j === i) continue;
      const id = edgeId(units.ids[i], units.ids[j]);
      if (seen.has(id)) continue;
      seen.add(id);
      edges.ids.push(id);
      edges.cols.src!.push(units.ids[i]);
      edges.cols.dst!.push(units.ids[j]);
      edges.cols.kind!.push(rnd() < 0.6 ? 'import' : 'call');
      edges.cols.weight!.push(1 + Math.log(1 + Math.floor(rnd() * 8)));
      edges.cols.confidence!.push(rnd() < 0.8 ? 1 : 0.5);
      edges.cols.mechanism!.push('');
      edges.cols.symbols!.push('');
      units.cols.fanOut![i]++;
      units.cols.fanIn![j]++;
    }
  }
  // importance: percentile of fan-in among the units that have any (a stand-in for PageRank); 0 for the rest
  const order = Array.from({ length: n }, (_, i) => i).filter((u) => units.cols.fanIn![u] > 0)
    .sort((a, b) => units.cols.fanIn![a] - units.cols.fanIn![b] || a - b);
  order.forEach((u, rank) => { units.cols.importancePct![u] = (rank + 1) / order.length; });

  return { city: cities, district: districts, unit: units, file: files, edge: edges };
}

const LANG_NAMES: Record<string, string> = { ts: 'TypeScript', js: 'JavaScript', python: 'Python', cpp: 'C++', c: 'C', go: 'Go', rust: 'Rust', java: 'Java' };

export function syntheticMeta(name = 'synthetic', tables?: StructureTables): RepoMeta {
  const languages: NonNullable<RepoMeta['languages']> = {};
  for (const id of new Set(tables?.unit.cols.lang ?? [])) languages[id] = { name: LANG_NAMES[id] ?? id, color: '#8a9099' };
  return {
    languages,
    id: `synthetic:${name}`, name, remoteUrl: null, source: 'synthetic', headOid: null, indexChecksum: null,
    parserVersion: '0', parsedAt: 0, structure: 'full',
    stats: {
      files: tables?.file.ids.length ?? 0, units: tables?.unit.ids.length ?? 0, edges: tables?.edge.ids.length ?? 0,
      loc: tables?.unit.cols.loc?.reduce((a, b) => a + b, 0) ?? 0,
    },
  };
}

/** Add-operations for whole tables, in dependency order (cities, districts, units, files, edges). No slots. */
export function tablesToOps(tables: StructureTables): ModelPatch[] {
  const ops: ModelPatch[] = [];
  for (const kind of ENTITY_KINDS) {
    const rows = (tables as Partial<Record<EntityKind, ColumnChunk>>)[kind];
    if (rows && rows.ids.length) ops.push({ op: 'add', kind, rows } as ModelPatch);
  }
  return ops;
}

/**
 * An applied `full` batch for whole tables, with slot i for row i — what a store would emit when
 * loading these tables into an empty model. Lets replica consumers be tested without a store.
 */
export function tablesToFullBatch(tables: StructureTables, meta: RepoMeta = syntheticMeta('synthetic', tables), rev = 1): PatchBatch {
  const ops: ModelPatch[] = [{ op: 'meta', value: meta }];
  for (const op of tablesToOps(tables)) {
    if (op.op !== 'add') continue;
    ops.push({ ...op, rows: { ...op.rows, slots: op.rows.ids.map((_, i) => i) } } as ModelPatch);
  }
  return { rev, baseRev: rev - 1, ops, full: true };
}

/** Convenience: a synthetic model as one applied full batch. */
export function syntheticBatch(opts: SyntheticOptions): PatchBatch {
  const tables = syntheticTables(opts);
  return tablesToFullBatch(tables, syntheticMeta(`synthetic-${opts.files}`, tables));
}
