// The structure section (PLAN.md §11.2, ~35%): the architecture as measured. Cities and districts
// with size, language mix and dominant paths; edge weights between cities and between districts;
// entry points; build manifests reduced to names.
import type { NodeRef } from '../../model/types';
import { basename } from '../../shared';
import type { Ctx } from './ctx';
import { Cite, entry, render, select } from './items';
import type { Entry, Section } from './items';
import { readManifests } from './manifests';
import type { ManifestInfo } from './manifests';
import type { CityInfo, DistrictInfo, GroupStats, Link, UnitInfo } from './model';
import { cmpStr, oneLine } from './seeded';
import { LOCAL } from './tunables';

export const NOTATION =
  'References: c:<id> is a city, d:<id> a district, u:<path> one file; only u: references are files. Cite them exactly as written. ' +
  'Lists are shuffled, so position carries no meaning. In link lists, w is the summed link weight and n the number of file-to-file links. ' +
  '"stands for it" names the file that best represents a city or district: the one with the most links to other files inside it.';

const HEADING = '## Structure (measured from imports, calls and references)';

const pct = (share: number): string => `${Math.round(share * 100)}%`;

export function label(x: { id: string; name: string }, ref: string): string {
  return x.name && x.name !== x.id ? `${ref} "${oneLine(x.name, LOCAL.structure.nameChars)}"` : ref;
}

function facts(g: GroupStats): string {
  let s = `${g.files} files, ${g.loc} lines`;
  if (g.tests) s += `, ${g.tests} test files`;
  if (g.langs.length) s += `; ${g.langs.map(([lang, share]) => `${lang} ${pct(share)}`).join(', ')}`;
  if (g.prefixes.length) s += `; paths ${g.prefixes.map(([dir, share]) => `${dir === '' ? '.' : dir}/ ${pct(share)}`).join(', ')}`;
  return s;
}

export function cityLine(c: CityInfo, cite: Cite): string {
  return `${label(c, cite.r(c.ref))} — ${c.districts.length} districts, ${facts(c)}`;
}

export function districtLine(d: DistrictInfo, cite: Cite): string {
  return `${label(d, cite.r(d.ref))} — ${facts(d)}`;
}

/**
 * The files that best represent each district (one) and city (up to `cityRepresentatives`, from
 * different districts when possible): the citable file with the most links to other files inside
 * the area, importance breaking ties. A point about a whole area can stand on one of these.
 */
export function representatives(ctx: Ctx): { district: number[]; city: number[][] } {
  return ctx.once('representatives', () => {
    const { units, districts, cities } = ctx.view;
    const best = (pool: UnitInfo[], links: (u: UnitInfo) => number) =>
      pool.sort((a, b) => links(b) - links(a) || b.importance - a.importance || a.index - b.index);
    const district = districts.map((d) => {
      const pool = best(d.units.map((i) => units[i]).filter((u) => ctx.citable(u)), (u) => u.linksInDistrict);
      return pool.length ? pool[0].index : -1;
    });
    const city = cities.map((c) => {
      const pool = best(c.districts.flatMap((d) => districts[d].units).map((i) => units[i]).filter((u) => ctx.citable(u)), (u) => u.linksInCity);
      const picked: UnitInfo[] = [];
      // One per district first, then whoever is next.
      for (const u of pool) if (picked.length < LOCAL.structure.cityRepresentatives && !picked.some((p) => p.district === u.district)) picked.push(u);
      for (const u of pool) if (picked.length < LOCAL.structure.cityRepresentatives && !picked.includes(u)) picked.push(u);
      return picked.map((u) => u.index);
    });
    return { district, city };
  });
}

function standsFor(ctx: Ctx, unitIndexes: readonly number[], links: (u: UnitInfo) => number, cite: Cite, indent: string): string | null {
  if (unitIndexes.length === 0) return null;
  const shown = [...unitIndexes].sort((a, b) => ctx.unitRank[a] - ctx.unitRank[b]).map((i) => ctx.view.units[i]);
  return `${indent}stands for it: ${shown.map((u) => `${cite.r(u.ref)} (${links(u)} links inside)`).join(', ')}`;
}

/** A city's line with its representative files under it. */
export function cityBlock(ctx: Ctx, c: CityInfo, cite: Cite, indent = ''): string {
  const line = standsFor(ctx, representatives(ctx).city[c.index], (u) => u.linksInCity, cite, `${indent}  `);
  const head = `${indent}${cityLine(c, cite)}`;
  return line ? [head, line].join('\n') : head;
}

/** A district's line with its representative file under it. */
export function districtBlock(ctx: Ctx, d: DistrictInfo, cite: Cite, indent = ''): string {
  const rep = representatives(ctx).district[d.index];
  const line = standsFor(ctx, rep < 0 ? [] : [rep], (u) => u.linksInDistrict, cite, `${indent}  `);
  const head = `${indent}${districtLine(d, cite)}`;
  return line ? [head, line].join('\n') : head;
}

function weight(milli: number): string {
  const w = milli / 1000;
  return w >= 10 ? String(Math.round(w)) : w.toFixed(1);
}

/** The strongest `max` links, shown in the shuffled order of their targets. */
function linkList(links: readonly Link[], max: number, targets: readonly { ref: NodeRef }[], rank: Int32Array, cite: Cite): string {
  return links
    .slice(0, max)
    .sort((a, b) => rank[a.to] - rank[b.to])
    .map((l) => `${cite.r(targets[l.to].ref)} w${weight(l.milli)} n${l.n}`)
    .join(', ');
}

function edgeLines(out: readonly Link[], inn: readonly Link[], max: number, targets: readonly { ref: NodeRef }[], rank: Int32Array, cite: Cite, indent: string, none: string): string {
  const lines: string[] = [];
  if (out.length) lines.push(`${indent}depends on: ${linkList(out, max, targets, rank, cite)}`);
  if (inn.length) lines.push(`${indent}used by: ${linkList(inn, max, targets, rank, cite)}`);
  return lines.length ? lines.join('\n') : `${indent}${none}`;
}

// ---- entry points ----

export interface EntryPoint {
  unit: number;
  score: number;
  why: string;
}

const STRONG_NAMES = new Set(['main', 'cli', 'app', 'server', '__main__', 'program', 'application', 'bootstrap', 'manage', 'entry', 'start']);
const WEAK_NAMES = new Set(['index', 'lib', 'mod']);

/**
 * Entry points per city, most likely first: files a manifest declares (`main`, `bin`, scripts),
 * files with entry-style names that little or nothing depends on, and roots of the dependency
 * graph with a high fan-out.
 */
export function entryPoints(ctx: Ctx): EntryPoint[][] {
  return ctx.once('entryPoints', () => {
    const { units, cities } = ctx.view;
    const declared = new Map<number, string>();
    for (const m of readManifests(ctx)) for (const e of m.entries) if (!declared.has(e.unit)) declared.set(e.unit, e.why);

    const fanOuts = units.filter((u) => ctx.citable(u)).map((u) => u.fanOut).sort((a, b) => a - b);
    const p90 = fanOuts.length ? fanOuts[Math.floor(fanOuts.length * 0.9)] : 0;
    const highFanOut = Math.max(LOCAL.structure.entryMinFanOut, p90);

    const byCity: EntryPoint[][] = cities.map(() => []);
    for (const u of units) {
      if (!ctx.citable(u)) continue;
      const base = basename(u.id);
      const dot = base.lastIndexOf('.');
      const stem = (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
      const how = declared.get(u.index);
      const strong = STRONG_NAMES.has(stem) && u.fanIn <= 1;
      const weak = WEAK_NAMES.has(stem) && u.fanIn === 0 && u.fanOut >= 2;
      const root = u.fanIn === 0 && u.fanOut >= highFanOut;
      if (!how && !strong && !weak && !root) continue;
      const why: string[] = [];
      if (how) why.push(how);
      if (strong || weak) why.push(`name "${stem}"`);
      why.push(`fan-out ${u.fanOut}, fan-in ${u.fanIn}`);
      const score = (how ? 100 : 0) + (strong ? 40 : 0) + (weak ? 10 : 0) + Math.min(u.fanOut, 50) - 5 * u.fanIn;
      byCity[u.city].push({ unit: u.index, score, why: why.join('; ') });
    }
    for (const list of byCity) list.sort((a, b) => b.score - a.score || cmpStr(units[a.unit].id, units[b.unit].id));
    return byCity;
  });
}

function entryPointLine(ctx: Ctx, ep: EntryPoint, cite: Cite, indent: string): string {
  const u = ctx.view.units[ep.unit];
  return `${indent}entry point ${cite.r(u.ref)} (${cite.r(ctx.view.districts[u.district].ref)}) — ${ep.why}`;
}

function manifestLine(ctx: Ctx, m: ManifestInfo, cite: Cite): string {
  const u: UnitInfo | undefined = ctx.view.units[m.unit];
  const where = u && ctx.citable(u) ? cite.r(u.ref) : m.path;
  return `  ${where} — ${m.summary}`;
}

const MANIFESTS_HEADING = 'Build manifests (names, targets and script names only):';

// ---- the section ----

/** Pushes the entries of one city in priority tiers; `tiers[k]` collects tier k across cities. */
function cityEntries(ctx: Ctx, c: CityInfo, tiers: Entry[][], posBase: readonly number[], limits: { cityEdges: number; entryPoints: number }): void {
  const { view } = ctx;
  const key = `c${c.index}`;
  const indent = '  ';

  let cite = new Cite();
  tiers[0].push(entry(key, [...posBase, 0], cityBlock(ctx, c, cite), cite.refs));

  cite = new Cite();
  const cityEdges = edgeLines(view.cityOut[c.index], view.cityIn[c.index], limits.cityEdges, view.cities, ctx.cityRank, cite, indent, 'no links to or from other cities');
  tiers[1].push(entry(`${key}:edges`, [...posBase, 1], cityEdges, cite.refs, key));

  entryPoints(ctx)[c.index].slice(0, limits.entryPoints).forEach((ep, rank) => {
    const cite = new Cite();
    const text = entryPointLine(ctx, ep, cite, indent);
    // Rank r of every city comes before rank r + 1 of any city.
    (tiers[2 + rank] ??= []).push(entry(`${key}:ep${ep.unit}`, [...posBase, 2, ctx.unitRank[ep.unit]], text, cite.refs, key));
  });
}

function districtEntries(ctx: Ctx, c: CityInfo, headers: Entry[][], edges: Entry[][], posBase: readonly number[]): void {
  const { view } = ctx;
  const bySize = c.districts.map((d) => view.districts[d]).sort((a, b) => b.files - a.files || a.index - b.index);
  bySize.forEach((d, rank) => {
    const key = `d${d.index}`;
    const pos = [...posBase, 3, ctx.districtRank[d.index]];
    let cite = new Cite();
    (headers[rank] ??= []).push(entry(key, [...pos, 0], districtBlock(ctx, d, cite, '  '), cite.refs, `c${c.index}`));
    const out = view.districtOut[d.index], inn = view.districtIn[d.index];
    if (out.length + inn.length === 0) return;
    cite = new Cite();
    const text = edgeLines(out, inn, LOCAL.structure.districtEdges, view.districts, ctx.districtRank, cite, '    ', '');
    (edges[rank] ??= []).push(entry(`${key}:edges`, [...pos, 1], text, cite.refs, key));
  });
}

function manifestEntries(ctx: Ctx, manifests: readonly ManifestInfo[]): Entry[] {
  if (manifests.length === 0) return [];
  const out = [entry('manifests', [2, 0], MANIFESTS_HEADING)];
  manifests.slice(0, LOCAL.structure.manifests).forEach((m, i) => {
    const cite = new Cite();
    out.push(entry(`m${i}`, [2, 1, i], manifestLine(ctx, m, cite), cite.refs, 'manifests'));
  });
  return out;
}

function repoHead(ctx: Ctx): string {
  const { view } = ctx;
  const t = view.totals;
  const counted: string[] = [];
  if (t.tests) counted.push(`${t.tests} test files`);
  if (t.hidden) counted.push(`${t.hidden} vendored, generated or withheld files`);
  const lines = [
    `# Repository digest${view.name ? `: "${oneLine(view.name, LOCAL.structure.nameChars)}"` : ''}`,
    `${t.files} files, ${t.loc} lines, ${t.edges} dependency links between files; ${view.cities.length} cities, ${view.districts.length} districts.` +
      (t.langs.length ? ` Languages: ${t.langs.map(([lang, share]) => `${lang} ${pct(share)}`).join(', ')}.` : '') +
      (counted.length ? ` Counted but not shown: ${counted.join(', ')}.` : '') +
      (t.unplaced ? ` ${t.unplaced} files are not placed in a district yet.` : ''),
    NOTATION,
    '',
    HEADING,
  ];
  return lines.join('\n');
}

function repoEntries(ctx: Ctx): Entry[] {
  const { view } = ctx;
  const cityTiers: Entry[][] = [[], []];
  const headers: Entry[][] = [], edges: Entry[][] = [];
  // Larger cities first within a tier: under pressure the small print of small cities goes first.
  const bySize = [...view.cities].sort((a, b) => b.files - a.files || a.index - b.index);
  for (const c of bySize) {
    const posBase = [1, ctx.cityRank[c.index]];
    cityEntries(ctx, c, cityTiers, posBase, { cityEdges: LOCAL.structure.cityEdges, entryPoints: LOCAL.structure.entryPointsPerCity });
    districtEntries(ctx, c, headers, edges, posBase);
  }
  return [
    entry('head', [0], repoHead(ctx)),
    ...cityTiers.flat(),
    ...manifestEntries(ctx, readManifests(ctx)),
    ...headers.flat(),
    ...edges.flat(),
  ];
}

function cityScopeEntries(ctx: Ctx, c: CityInfo): Entry[] {
  const { view } = ctx;
  const cite = new Cite();
  const head = [
    `# City ${cite.r(c.ref)} of repository${view.name ? ` "${oneLine(view.name, LOCAL.structure.nameChars)}"` : ''}`,
    `One of ${view.cities.length} cities; the whole repository has ${view.totals.files} files and ${view.totals.loc} lines.`,
    NOTATION,
    '',
    HEADING,
  ].join('\n');
  const cityTiers: Entry[][] = [[], []];
  const headers: Entry[][] = [], edges: Entry[][] = [];
  cityEntries(ctx, c, cityTiers, [1], { cityEdges: LOCAL.city.cityEdges, entryPoints: LOCAL.city.entryPoints });
  districtEntries(ctx, c, headers, edges, [1]);
  // The repository's root manifests, and those that sit in this city.
  const manifests = readManifests(ctx).filter((m) => m.depth === 0 || view.units[m.unit]?.city === c.index);
  return [
    entry('head', [0], head, cite.refs),
    ...cityTiers.flat(),
    ...headers.flat(),
    ...edges.flat(),
    ...manifestEntries(ctx, manifests),
  ];
}

/** `city` is a canonical city index, or null for the whole repository. */
export function structureSection(ctx: Ctx, city: number | null): Section {
  const entries = city === null ? repoEntries(ctx) : cityScopeEntries(ctx, ctx.view.cities[city]);
  return {
    fill(budget) {
      const { chosen, truncated } = select(entries, budget);
      return render(chosen, truncated);
    },
  };
}
