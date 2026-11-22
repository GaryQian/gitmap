// The code-skeleton section (PLAN.md §11.2, ~35%): signatures and leading doc comments, no bodies,
// of a sample of files per district.
//
// Which files (not only hubs): per district a queue of [most important, most distinctive, one
// seeded-random representative] (which of the three leads rotates between districts), then the file
// the structure section names as standing for the district, the next most important ones, and
// everything else shuffled.
//
// How much each area gets (stratified): cities share the budget ∝ √size with a floor, and districts
// share their city's part the same way. The split is a weighted fair queue: the city, then the
// district, that has so far received least for its weight takes its next file. A group that runs
// out of files simply stops asking, so its share goes to the others.
import type { SymbolDef } from '../../contracts/lang';
import { Ctx } from './ctx';
import { Cite, entry, render } from './items';
import type { Entry, Section } from './items';
import type { DistrictInfo, UnitInfo } from './model';
import { oneLine, shuffle } from './seeded';
import { label, representatives } from './structure';
import { costOf } from './tokens';
import { LOCAL } from './tunables';

const HEADING = [
  '## Code skeletons (measured)',
  'Signatures and leading doc comments of a sample of files in each district: some central, some unusual, some picked at random. Bodies are omitted. Being listed here does not make a file important.',
].join('\n');

// ---- which files ----

/** Words of an identifier: camelCase, PascalCase and snake_case parts, lower-cased. */
function words(name: string): string[] {
  const parts = name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g);
  return parts ? parts.map((p) => p.toLowerCase()).filter((p) => p.length > 1) : [];
}

/**
 * Distinctiveness of each unit: how rare the words of its symbol names are across the repository.
 * Each distinct word scores ln((N + 1) / (unitsUsingIt + 1)); a unit's score is the sum over its
 * words divided by √(word count), so a file needs several rare words, not one. −1 for a unit with
 * no definitions.
 */
function distinctiveness(ctx: Ctx): Float64Array {
  return ctx.once('distinctiveness', () => {
    const { units } = ctx.view;
    const wordCache = new Map<string, string[]>();
    const unitWords: (string[] | null)[] = units.map(() => null);
    const usedBy = new Map<string, number>();
    let n = 0;
    for (const u of units) {
      if (!ctx.citable(u) || !ctx.hasDefs(u)) continue;
      const own = new Set<string>();
      let taken = 0;
      for (const path of u.files) {
        for (const d of ctx.syntax.get(path)?.defs ?? []) {
          if (taken++ >= LOCAL.skeletons.distinctiveDefs) break;
          let w = wordCache.get(d.name);
          if (!w) wordCache.set(d.name, (w = words(d.name)));
          for (const word of w) own.add(word);
        }
      }
      // In the order the definitions were kept, which is part of the input, so the sum below is stable.
      unitWords[u.index] = [...own];
      for (const word of own) usedBy.set(word, (usedBy.get(word) ?? 0) + 1);
      n++;
    }
    const scores = new Float64Array(units.length).fill(-1);
    unitWords.forEach((list, i) => {
      if (!list) return;
      let sum = 0;
      for (const word of list) sum += Math.log((n + 1) / (usedBy.get(word)! + 1));
      scores[i] = list.length ? sum / Math.sqrt(list.length) : 0;
    });
    return scores;
  });
}

function defCount(ctx: Ctx, u: UnitInfo): number {
  let n = 0;
  for (const path of u.files) n += ctx.syntax.get(path)?.defs.length ?? 0;
  return n;
}

/** The order in which each district offers its files. */
function queues(ctx: Ctx): number[][] {
  return ctx.once('skeletonQueues', () => {
    const { units, districts } = ctx.view;
    const rarity = distinctiveness(ctx);
    return districts.map((d) => {
      const candidates = d.units.filter((i) => ctx.citable(units[i]) && ctx.hasDefs(units[i]));
      if (candidates.length === 0) return [];
      const taken = new Set<number>();
      const queue: number[] = [];
      const take = (i: number | undefined) => { if (i !== undefined && !taken.has(i)) { taken.add(i); queue.push(i); } };

      const byImportance = [...candidates].sort((a, b) =>
        units[b].importance - units[a].importance || units[b].fanIn - units[a].fanIn || a - b);
      const central = byImportance[0];

      const others = candidates.filter((i) => i !== central);
      const substantial = others.filter((i) => defCount(ctx, units[i]) >= LOCAL.skeletons.distinctiveMinDefs);
      let distinctive: number | undefined;
      for (const i of substantial.length ? substantial : others) if (distinctive === undefined || rarity[i] > rarity[distinctive]) distinctive = i;

      const rnd = ctx.rng(`skeleton:${d.id}`);
      const rest = others.filter((i) => i !== distinctive);
      const representative = rest.length ? rest[Math.floor(rnd() * rest.length)] : undefined;

      // Which of the three leads rotates from district to district, so that when the budget allows
      // only one file per district the sample is still a third central, a third unusual, a third random.
      const lead = [central, distinctive, representative];
      const turn = ctx.districtRank[d.index] % lead.length;
      for (let k = 0; k < lead.length; k++) take(lead[(turn + k) % lead.length]);
      // Then the file the structure section names as standing for the district, if it is not in yet.
      const stands = representatives(ctx).district[d.index];
      if (stands >= 0 && candidates.includes(stands)) take(stands);

      for (const i of byImportance.slice(1, LOCAL.skeletons.topByImportance)) take(i);
      for (const i of shuffle(candidates.filter((i) => !taken.has(i)), rnd)) take(i);
      return queue;
    });
  });
}

// ---- one file ----

function defLine(d: SymbolDef): string {
  const { signatureChars, docChars } = LOCAL.skeletons;
  const where = d.container ? `${d.container}.` : '';
  // A signature is the definition's first line; an opening brace left on it says nothing.
  const signature = d.signature ? oneLine(d.signature.replace(/\s*\{\s*$/, ''), signatureChars) : `${d.kind} ${where}${d.name}`;
  const owner = d.signature && d.container && !d.signature.includes(d.container) ? `[${oneLine(d.container, 40)}] ` : '';
  const doc = d.doc ? `  // ${oneLine(d.doc.replace(/^[\s/*#!-]+|[\s/*]+$/g, ''), docChars)}` : '';
  return `${owner}${signature}${doc}`;
}

/**
 * A file's skeleton within `cap` tokens: the public, top-level definitions first when not all fit,
 * shown in source order. Null when the file has no definitions or is withheld. `cap` of Infinity
 * gives every definition.
 */
export function skeletonText(ctx: Ctx, u: UnitInfo, cap: number, cite: Cite, indent = '  '): string | null {
  const defs = ctx.defsOf(u);
  if (defs.length === 0 || ctx.unitWithheld(u)) return null;
  const head = `${indent}${cite.r(u.ref)} — ${u.lang}, ${u.loc} lines, fan-in ${u.fanIn}, fan-out ${u.fanOut}`;
  const lines = defs.map((d) => `${indent}  ${defLine(d)}`);
  const rank = (d: SymbolDef) => (d.exported === false ? 2 : 0) + (d.container ? 1 : 0);
  const preference = defs.map((_, i) => i).sort((a, b) => rank(defs[a]) - rank(defs[b]) || a - b);
  const more = (n: number) => `${indent}  (+${n} more definitions)`;
  let used = costOf(head);
  const kept: number[] = [];
  for (const i of preference) {
    const cost = costOf(lines[i]);
    const left = defs.length - kept.length - 1;
    // Leave room for the "+N more" line; the first definition is shown whatever it costs.
    if (kept.length > 0 && used + cost + (left > 0 ? costOf(more(left)) : 0) > cap) continue;
    kept.push(i);
    used += cost;
  }
  kept.sort((a, b) => a - b);
  const out = [head, ...kept.map((i) => lines[i])];
  if (kept.length < defs.length) out.push(more(defs.length - kept.length));
  return out.join('\n');
}

// ---- the section ----

interface DistrictState { d: DistrictInfo; weight: number; spent: number; next: number; queue: number[]; header: Entry | null }
interface CityState { weight: number; spent: number; districts: DistrictState[] }

/** The state with remaining work that has received least for its weight; earlier wins a tie. */
function neediest<T extends { weight: number; spent: number }>(states: readonly T[], live: (s: T) => boolean): T | null {
  let best: T | null = null;
  for (const s of states) {
    if (!live(s)) continue;
    if (best === null || s.spent * best.weight < best.spent * s.weight) best = s;
  }
  return best;
}

/** `city` is a canonical city index, or null for the whole repository. */
export function skeletonSection(ctx: Ctx, city: number | null): Section {
  const { view } = ctx;
  const all = queues(ctx);
  const cityIndexes = city === null ? view.cities.map((c) => c.index) : [city];
  const cityShares = city === null ? ctx.cityShares : [1];

  return {
    fill(budget) {
      // Heaviest first, so that ties (everyone starts at zero) go to the larger group.
      const heaviest = <T extends { weight: number }>(list: T[]) => list.sort((a, b) => b.weight - a.weight);
      const states: CityState[] = heaviest(cityIndexes.map((ci, k) => {
        const members = view.cities[ci].districts.map((d) => view.districts[d]).filter((d) => all[d.index].length > 0);
        const shares = Ctx.shares(members.map((d) => d.files));
        const districts = heaviest(members.map((d, j): DistrictState => ({ d, weight: shares[j], spent: 0, next: 0, queue: all[d.index], header: null })));
        return { weight: cityShares[k], spent: 0, districts };
      }));
      const active = states.reduce((n, s) => n + s.districts.length, 0);
      const [minFile, maxFile] = LOCAL.skeletons.fileTokens;
      const heading = entry('head', [-1], active ? HEADING : `${HEADING}\n(no signatures are available)`);
      const fileCap = Math.min(maxFile, Math.max(minFile, Math.floor((budget - heading.cost) / (2 * Math.max(1, active)))));

      const chosen: Entry[] = [heading];
      let used = heading.cost, misses = 0, truncated = false;
      const liveDistrict = (s: DistrictState) => s.next < s.queue.length;
      const liveCity = (s: CityState) => s.districts.some(liveDistrict);
      for (;;) {
        const cs = neediest(states, liveCity);
        if (!cs) break;
        const ds = neediest(cs.districts, liveDistrict)!;
        const u = view.units[ds.queue[ds.next++]];
        const cite = new Cite();
        const text = skeletonText(ctx, u, fileCap, cite);
        if (text === null) continue;
        const pos = [ctx.cityRank[ds.d.city], ctx.districtRank[ds.d.index]];
        let header: Entry | null = null;
        if (!ds.header) {
          const hc = new Cite();
          const line = city === null ? `${label(ds.d, hc.r(ds.d.ref))} in ${hc.r(view.cities[ds.d.city].ref)}` : label(ds.d, hc.r(ds.d.ref));
          header = entry(`d${ds.d.index}`, [...pos, 0], line, hc.refs);
        }
        const file = entry(`u${u.index}`, [...pos, 1, ctx.unitRank[u.index]], text, cite.refs);
        const cost = file.cost + (header ? header.cost : 0);
        if (used + cost > budget) {
          truncated = true;
          if (++misses > LOCAL.skeletons.maxMisses) break;
          continue;
        }
        misses = 0;
        if (header) { ds.header = header; chosen.push(header); }
        chosen.push(file);
        used += cost;
        ds.spent += cost;
        cs.spent += cost;
      }
      return render(chosen, truncated);
    },
  };
}
