// The name a city goes by on screen (PLAN.md §11.1, §17.6). A city is first named from its folders
// ("render"); once AI notes exist, the title the notes gave it ("Map rendering") is the better name
// and replaces it everywhere a city is named to the user. The model keeps the folder-derived name:
// it is what the notes were written against, so swapping it there would make them look out of date.
// Pure, and over plain data, so the app and the chat context share the one rule.

export interface CityName {
  /** What the pill, the cards and the chat call the city. */
  title: string;
  /** The name derived from its folders. Equal to `title` until AI notes give the city a title. */
  derived: string;
  /** True when `title` came from AI notes. */
  titled: boolean;
}

/** Joins a title to the folder name that tells two cities with the same title apart. */
export const TITLE_SEPARATOR = ' · ';

/** Case and spacing do not make two titles different. */
const key = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Names for `cities`, by city id. `labels` holds the AI title of a city by its id; a city without
 * one keeps its derived name. Two cities given the same title would be two pills that read alike,
 * so each of them carries its derived name after the title ("API documentation · g3doc").
 */
export function cityTitles(cities: readonly { id: string; name: string }[], labels: ReadonlyMap<string, string | undefined>): Map<string, CityName> {
  const wanted = new Map<string, string>();
  const uses = new Map<string, number>();
  for (const city of cities) {
    const label = (labels.get(city.id) ?? '').replace(/\s+/g, ' ').trim();
    if (label === '' || key(label) === key(city.name)) continue;
    wanted.set(city.id, label);
    uses.set(key(label), (uses.get(key(label)) ?? 0) + 1);
  }
  // a title that is another city's folder name reads as that city too
  for (const city of cities) {
    if (!wanted.has(city.id) && uses.has(key(city.name))) uses.set(key(city.name), uses.get(key(city.name))! + 1);
  }
  const out = new Map<string, CityName>();
  for (const city of cities) {
    const label = wanted.get(city.id);
    if (label === undefined) { out.set(city.id, { title: city.name, derived: city.name, titled: false }); continue; }
    const shared = (uses.get(key(label)) ?? 0) > 1 && city.name.trim() !== '';
    out.set(city.id, { title: shared ? `${label}${TITLE_SEPARATOR}${city.name}` : label, derived: city.name, titled: true });
  }
  return out;
}
