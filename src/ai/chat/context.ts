// The map overview that travels in `ChatRequest.context` (PLAN.md §11.5, "Context when needed"):
// the repository's name and size, its languages, and every city with its ref, name, size, district
// names and stored AI summary. Pure, and built from a ModelReplica alone.
//
// It is the cached prefix of every chat request, so it is deterministic: nothing is ordered or
// keyed by slot (slots are per session), numbers are written without locale formatting, and the
// same model gives the same text byte for byte. Details come through the tools.
import type { ModelReplica } from '../../contracts/store';
import { cityRef, districtRef } from '../../model/types';
import { CHARS_PER_TOKEN, estimateTokens } from '../tokens';
import { CHAT_TUNABLES } from './tunables';

export interface ChatContextOptions {
  /** Estimated tokens the overview may take. Default `CHAT_TUNABLES.contextTokens`. */
  maxTokens?: number;
}

interface Area { id: string; name: string; files: number; loc: number }
interface City extends Area { districts: Area[]; label: string; summary: string }

/** Detail levels tried in order until the text fits: districts named per city, characters of a summary. */
const LEVELS: readonly (readonly [districts: number, summaryChars: number])[] = [
  [16, 500], [8, 500], [4, 320], [0, 320], [0, 160], [0, 0],
];
/** Languages named before the rest are folded into "other". */
const MAX_LANGUAGES = 8;

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Largest first; ties by id, so the order never depends on slots or insertion. */
const bySize = (a: Area, b: Area) => b.loc - a.loc || b.files - a.files || cmpStr(a.id, b.id);
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function readCities(replica: ModelReplica): { cities: City[]; districts: number } {
  const cityTable = replica.table('city');
  const districtTable = replica.table('district');
  const unitTable = replica.table('unit');

  const cities = new Map<string, City>();
  for (const slot of cityTable.slots()) {
    const id = cityTable.ids[slot]!;
    cities.set(id, { id, name: oneLine(cityTable.cols.name[slot] ?? ''), files: 0, loc: 0, districts: [], label: '', summary: '' });
  }
  const districts = new Map<string, Area & { city: string }>();
  for (const slot of districtTable.slots()) {
    const id = districtTable.ids[slot]!;
    districts.set(id, { id, name: oneLine(districtTable.cols.name[slot] ?? ''), files: 0, loc: 0, city: districtTable.cols.city[slot] ?? '' });
  }
  for (const slot of unitTable.slots()) {
    const district = districts.get(unitTable.cols.district[slot] ?? '');
    if (!district) continue; // not clustered yet
    const files = unitTable.cols.fileCount[slot] || 1;
    const loc = unitTable.cols.loc[slot] || 0;
    district.files += files;
    district.loc += loc;
    const city = cities.get(district.city);
    if (city) { city.files += files; city.loc += loc; }
  }
  for (const d of districts.values()) cities.get(d.city)?.districts.push(d);
  const byRef = new Map([...cities.values()].map((c) => [cityRef(c.id) as string, c]));
  for (const a of replica.annotations) {
    const city = a.type === 'summary' ? byRef.get(a.parent) : undefined;
    if (city && a.type === 'summary') { city.label = oneLine(a.label ?? ''); city.summary = oneLine(a.text); }
  }
  const list = [...cities.values()].sort(bySize);
  for (const c of list) c.districts.sort(bySize);
  return { cities: list, districts: districts.size };
}

function languageLine(replica: ModelReplica): string {
  const files = replica.table('file');
  const loc = new Map<string, number>();
  const count = new Map<string, number>();
  let totalLoc = 0;
  for (const slot of files.slots()) {
    const lang = files.cols.lang[slot] || 'other';
    const lines = files.cols.loc[slot] || 0;
    loc.set(lang, (loc.get(lang) ?? 0) + lines);
    count.set(lang, (count.get(lang) ?? 0) + 1);
    totalLoc += lines;
  }
  // By lines; by files when no lines are known (a model loaded before line counts existed).
  const weights = totalLoc > 0 ? loc : count;
  const total = totalLoc > 0 ? totalLoc : files.count;
  if (total === 0) return '';
  const names = replica.meta?.languages ?? {};
  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]));
  const parts: string[] = [];
  let other = 0;
  for (const [lang, weight] of ranked) {
    const pct = Math.round((weight / total) * 100);
    if (lang === 'other' || parts.length >= MAX_LANGUAGES || pct < 1) { other += weight; continue; }
    // the id in brackets is what the `language` arguments of the tools take
    parts.push(`${names[lang]?.name ?? lang} [${lang}] ${pct}%`);
  }
  const otherPct = Math.round((other / total) * 100);
  if (otherPct >= 1) parts.push(`other ${otherPct}%`);
  return `Languages by share of ${totalLoc > 0 ? 'lines' : 'files'}: ${parts.join(', ')}.`;
}

function render(header: string[], cities: City[], maxDistricts: number, summaryChars: number): string {
  const lines = [...header];
  for (const city of cities) {
    lines.push(`${cityRef(city.id)} | ${city.name || '(unnamed)'} | ${plural(city.files, 'file')} | ${plural(city.loc, 'line')}`);
    if (summaryChars > 0 && city.summary) {
      lines.push(`  summary${city.label ? ` (${city.label})` : ''}: ${clip(city.summary, summaryChars)}`);
    }
    if (maxDistricts > 0 && city.districts.length > 0) {
      const shown = city.districts.slice(0, maxDistricts)
        .map((d) => `${districtRef(d.id)} ${d.name || '(unnamed)'} (${d.files})`);
      const more = city.districts.length - shown.length;
      lines.push(`  districts: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`);
    } else if (city.districts.length > 0) {
      lines.push(`  districts: ${city.districts.length}`);
    }
  }
  return lines.join('\n');
}

/**
 * The compact overview of the open map for the chat assistant. Deterministic for a model, and at
 * most about `maxTokens` by the shared estimate: when a large map does not fit, district names go
 * first, then the summaries are shortened.
 */
export function buildChatContext(replica: ModelReplica, options: ChatContextOptions = {}): string {
  const maxTokens = options.maxTokens ?? CHAT_TUNABLES.contextTokens;
  const meta = replica.meta;
  const { cities, districts } = readCities(replica);
  const files = replica.table('file');
  let lines = 0;
  for (const slot of files.slots()) lines += files.cols.loc[slot] || 0;

  const header = [
    `Repository: ${oneLine(meta?.name ?? '') || '(unnamed)'}`,
    `Size: ${plural(files.count, 'file')}, ${plural(lines, 'line')}, ${plural(cities.length, 'city', 'cities')}, ${plural(districts, 'district')}.`,
  ];
  const languages = languageLine(replica);
  if (languages) header.push(languages);
  if (meta?.structure === 'imports-only') {
    header.push('Structure: provisional. Only import links are known so far; call links are still being worked out.');
  }
  if (cities.length === 0) {
    header.push('The map has no cities yet: the files have not been grouped.');
    return header.join('\n');
  }
  header.push(
    '',
    'Cities, largest first, as "ref | name | files | lines". A city is a group of districts; a district is a group of related files (its file count is in brackets).'
    + ' Summaries were written earlier by an AI model from the code.',
  );

  let text = '';
  for (const [maxDistricts, summaryChars] of LEVELS) {
    text = render(header, cities, maxDistricts, summaryChars);
    if (estimateTokens(text) <= maxTokens) return text;
  }
  // Even the barest form is too long (a budget far below the default): cut it, and say so.
  const note = '\n… (overview cut; get_repo_overview has the rest)';
  const room = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN) - note.length);
  return text.slice(0, text.lastIndexOf('\n', room) > 0 ? text.lastIndexOf('\n', room) : room) + note;
}
