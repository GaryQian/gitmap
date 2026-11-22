// The docs section (PLAN.md §11.2, ~30%): the root README, plus README / ARCHITECTURE / CONTRIBUTING /
// docs index at the root of each city's and major district's folders — a headings outline and the
// leading excerpt of each, from what the fast pass kept.
//
// Docs are claims, not measurements. The section says so in its heading and quotes every doc line
// behind "> ", so that nothing a README says can pass for the measured structure.
import { basename, dirname } from '../../shared';
import type { Ctx } from './ctx';
import { Cite, entry, render, select } from './items';
import type { Entry, Section } from './items';
import { cmpStr, oneLine, shuffledRanks } from './seeded';
import { costOf } from './tokens';
import { LOCAL } from './tunables';

const HEADING = [
  '## Docs (claims, not measurements)',
  'Leading excerpts of READMEs and other docs written by the repository\'s authors, quoted after ">". They are claims: they may be stale, incomplete or promotional. Use them for intent and vocabulary, and reconcile each claim with the measured structure and the code skeletons; where they disagree, the measurements win.',
].join('\n');

const TEXT = '(?:md|markdown|mdx|rst|txt|adoc|org)';
const NAMED = new RegExp(`^(readme|architecture|contributing)(?:\\.${TEXT})?$`, 'i');
const INDEX = new RegExp(`^index\\.${TEXT}$`, 'i');
/** Folders whose docs speak for the folder above them. */
const DOC_DIRS = new Set(['docs', 'doc', 'documentation', '.github']);
const KIND = { readme: 0, architecture: 1, index: 2, contributing: 3 } as const;

interface DocInfo {
  path: string;
  /** Unit of the doc file, or −1. */
  unit: number;
  kind: number;
  /** The folder the doc speaks for; '' is the repository root. */
  dir: string;
  /** Files under that folder, and the city and district that hold most of them. */
  coverage: number;
  city: number;
  cityShare: number;
  district: number;
  districtShare: number;
  lines: string[];
  outline: string[];
  rank: number;
  full?: number;
}

function classify(path: string): { kind: number; dir: string } | null {
  const base = basename(path);
  let dir = dirname(path);
  const parent = basename(dir).toLowerCase();
  const named = NAMED.exec(base);
  let kind: number;
  if (named) kind = KIND[named[1].toLowerCase() as 'readme' | 'architecture' | 'contributing'];
  else if (INDEX.test(base) && DOC_DIRS.has(parent)) kind = KIND.index;
  else return null;
  if (DOC_DIRS.has(parent)) dir = dirname(dir);
  return { kind, dir };
}

/** Lines worth quoting (no blanks, badges, images or bare HTML) and the headings among them. */
function clean(excerpt: string, cut: boolean): { lines: string[]; outline: string[] } {
  const raw = excerpt.split(/\r?\n/);
  // An excerpt cut by the fast pass ends mid-line: drop the partial line.
  if (cut && raw.length > 1) raw.pop();
  const { lineChars, headingChars, outlineHeadings } = LOCAL.docs;
  const lines: string[] = [], outline: string[] = [];
  const underline = /^\s*(?:={3,}|-{3,}|~{3,}|\*{3,}|_{3,})\s*$/;
  let fenced = false;
  raw.forEach((rawLine, i) => {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) return;
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) {
      if (underline.test(line) || /^\s*(?:\[!\[|!\[|<!--)/.test(line) || /^\s*<.*>$/.test(line)) return;
      const hash = /^\s{0,3}#{1,6}\s+(.+?)[\s#]*$/.exec(line);
      const setext = !hash && /[A-Za-z]/.test(line) && /^\s*(?:={3,}|-{3,})\s*$/.test(raw[i + 1] ?? '');
      const heading = hash ? hash[1] : setext ? line.trim() : null;
      if (heading && outline.length < outlineHeadings) outline.push(oneLine(heading, headingChars));
    }
    lines.push(line.length > lineChars ? line.slice(0, lineChars - 1) + '…' : line);
  });
  return { lines, outline };
}

function docs(ctx: Ctx): DocInfo[] {
  return ctx.once('docs', () => {
    const { view } = ctx;
    const found: DocInfo[] = [];
    for (const path of [...ctx.facts.keys()].sort(cmpStr)) {
      const excerpt = ctx.facts.get(path)!.excerpt;
      const cls = classify(path);
      if (!cls || !excerpt || !ctx.pathShown(path) || ctx.fileWithheld(path)) continue;
      const cut = !excerpt.endsWith('\n') && excerpt.length >= ctx.config.parser.excerptBytes * 0.9;
      const { lines, outline } = clean(excerpt, cut);
      if (lines.length === 0) continue;
      found.push({
        path, unit: view.unitOfFile.get(path) ?? -1, ...cls,
        coverage: 0, city: -1, cityShare: 0, district: -1, districtShare: 0, lines, outline, rank: 0,
      });
    }
    const ranks = shuffledRanks(found.length, ctx.rng('docs'));
    found.forEach((d, i) => { d.rank = ranks[i]; });

    // Which districts hold the files under each doc's folder.
    const perDir = new Map<string, Map<number, number>>();
    for (const d of found) if (!perDir.has(d.dir)) perDir.set(d.dir, new Map());
    const bump = (dir: string, district: number) => {
      const m = perDir.get(dir);
      if (m) m.set(district, (m.get(district) ?? 0) + 1);
    };
    for (const u of view.units) {
      if (u.district < 0) continue;
      for (let i = u.id.lastIndexOf('/'); i > 0; i = u.id.lastIndexOf('/', i - 1)) bump(u.id.slice(0, i), u.district);
      bump('', u.district);
    }
    for (const d of found) {
      const byDistrict = perDir.get(d.dir)!;
      const byCity = new Map<number, number>();
      for (const [district, n] of byDistrict) {
        d.coverage += n;
        const city = view.districts[district].city;
        byCity.set(city, (byCity.get(city) ?? 0) + n);
      }
      const most = (m: Map<number, number>): [number, number] => {
        let best = -1, count = 0;
        for (const [k, n] of m) if (n > count || (n === count && k < best)) { best = k; count = n; }
        return [best, count];
      };
      if (d.coverage === 0) continue;
      const [city, inCity] = most(byCity), [district, inDistrict] = most(byDistrict);
      d.city = city;
      d.cityShare = inCity / d.coverage;
      d.district = district;
      d.districtShare = inDistrict / d.coverage;
    }
    return found;
  });
}

const widest = (a: DocInfo, b: DocInfo) => b.coverage - a.coverage || a.kind - b.kind || cmpStr(a.path, b.path);

/** Repo scope: root docs, then the cities take turns (largest first), each offering its widest doc next. */
function repoOrder(ctx: Ctx): DocInfo[] {
  const all = docs(ctx);
  const root = all.filter((d) => d.dir === '').sort((a, b) => a.kind - b.kind || cmpStr(a.path, b.path));
  const perCity = ctx.view.cities.map((): DocInfo[] => []);
  for (const d of all) if (d.dir !== '' && d.city >= 0 && d.coverage >= LOCAL.docs.minFiles) perCity[d.city].push(d);
  for (const list of perCity) list.sort(widest);
  const turn = [...ctx.view.cities].sort((a, b) => b.files - a.files || a.index - b.index).map((c) => perCity[c.index]);
  const out = [...root];
  for (let r = 0; turn.some((list) => r < list.length); r++) for (const list of turn) if (r < list.length) out.push(list[r]);
  return out;
}

/** City scope: the city's own docs, widest first, then the root README for vocabulary. */
function cityOrder(ctx: Ctx, city: number): DocInfo[] {
  const all = docs(ctx);
  const own = all.filter((d) => d.dir !== '' && d.city === city && d.coverage >= LOCAL.docs.minFiles).sort(widest);
  const readme = all.find((d) => d.dir === '' && d.kind === KIND.readme);
  return readme ? [...own, readme] : own;
}

/** One doc within `cap` tokens: what it speaks for, its outline, then as many leading lines as fit. */
function docEntry(ctx: Ctx, d: DocInfo, cap: number, pos: readonly number[]): { entry: Entry; cut: boolean } {
  const { view } = ctx;
  const cite = new Cite();
  const u = view.units[d.unit];
  const where = u && ctx.citable(u) ? cite.r(u.ref) : d.path;
  let about = 'about the repository as a whole';
  if (d.dir !== '') {
    about = `about ${d.dir}/ (${d.coverage} files`;
    if (d.city >= 0 && d.cityShare >= LOCAL.docs.subjectShare) {
      about += `, mostly ${cite.r(view.cities[d.city].ref)}`;
      if (d.districtShare >= LOCAL.docs.subjectShare) about += ` / ${cite.r(view.districts[d.district].ref)}`;
    }
    about += ')';
  }
  const out = [`${where} — claims ${about}`];
  let used = costOf(out[0]);
  if (d.outline.length > 1) {
    const outline = `  outline: ${d.outline.join(' | ')}`;
    if (used + costOf(outline) <= cap) { out.push(outline); used += costOf(outline); }
  }
  let shown = 0;
  for (const line of d.lines) {
    const quoted = `  > ${line}`;
    const cost = costOf(quoted);
    if (used + cost > cap) break;
    out.push(quoted);
    used += cost;
    shown++;
  }
  return { entry: entry(`doc:${d.path}`, pos, out.join('\n'), cite.refs), cut: shown < d.lines.length };
}

/** `city` is a canonical city index, or null for the whole repository. */
export function docsSection(ctx: Ctx, city: number | null): Section {
  const ordered = city === null ? repoOrder(ctx) : cityOrder(ctx, city);
  const pos = (d: DocInfo): number[] => {
    const root = d.dir === '';
    // The root docs open the repo digest and close a city's context; the rest are shuffled.
    if (city === null) return root ? [0, d.kind, d.rank] : [1, d.rank];
    return root ? [1] : [0, d.rank];
  };
  return {
    fill(budget) {
      const heading = entry('head', [-1], ordered.length ? HEADING : `${HEADING}\n(no docs were found)`);
      const room = budget - heading.cost;
      const { minTokens } = LOCAL.docs;
      const shown = ordered.slice(0, Math.max(0, Math.floor(room / minTokens)));
      for (const d of shown) d.full ??= docEntry(ctx, d, Infinity, []).entry.cost;

      // Water-filling: short docs take what they need, and the rest is shared among the long ones.
      // What a doc does not use of its cap (docs are cut at line ends) rolls on to the next one.
      const built = new Map<DocInfo, Entry>();
      let left = room;
      let rest = shown.length;
      let cut = shown.length < ordered.length;
      const take = (d: DocInfo, cap: number) => {
        const b = docEntry(ctx, d, Math.min(d.full!, cap), pos(d));
        built.set(d, b.entry);
        cut ||= b.cut;
        left -= b.entry.cost;
        rest--;
      };
      const first = shown[0];
      if (city === null && first && first.dir === '' && first.kind === KIND.readme) take(first, Math.floor(room / 2));
      const last = shown[shown.length - 1];
      if (city !== null && last && last.dir === '' && shown.length > 1) take(last, minTokens * 2);
      for (const d of shown.filter((d) => !built.has(d)).sort((a, b) => a.full! - b.full! || cmpStr(a.path, b.path))) {
        take(d, Math.floor(left / rest));
      }

      // Priority order again, so that if anything still does not fit it is the least wide doc that goes.
      const { chosen, truncated } = select([heading, ...shown.map((d) => built.get(d)!)], budget);
      return render(chosen, truncated || cut);
    },
  };
}
