// select, clear_selection, focus_on, open_file: the tools that point at files. Each goes through the
// same store actions as a click, the search field or a pill, and reports what it did by name.
import type { ModelReplica } from '../../../contracts/store';
import { fileRef, unitRef, type NodeRef } from '../../../model/types';
import type { ToolOutcome } from '../contract';
import { CHAT_UI } from '../tunables';
import { fail, ok, type Args } from './args';
import type { ToolEnv } from './env';
import {
  cityAt, cleanPath, districtAt, findArea, findFile, findLanguage, mapLanguages, suggestAreas, suggestFiles, unitsIn, type AreaHit,
} from './lookup';

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * What to fly to so a set of files is in view: the one file, else the district that holds most of
 * them, else the city that does, else the whole map (null).
 */
export function frameFor(replica: ModelReplica, unitSlots: readonly number[]): { ref: NodeRef; label: string } | null {
  const units = replica.table('unit');
  if (unitSlots.length === 0) return null;
  if (unitSlots.length === 1) {
    const id = units.ids[unitSlots[0]!];
    return id == null ? null : { ref: unitRef(id), label: id };
  }
  const unitDistrict = units.refSlots.district ?? [];
  const districtCity = replica.table('district').refSlots.city ?? [];
  const perDistrict = new Map<number, number>(), perCity = new Map<number, number>();
  for (const s of unitSlots) {
    const d = unitDistrict[s] ?? -1;
    if (d < 0) continue;
    perDistrict.set(d, (perDistrict.get(d) ?? 0) + 1);
    const c = districtCity[d] ?? -1;
    if (c >= 0) perCity.set(c, (perCity.get(c) ?? 0) + 1);
  }
  const most = (counts: Map<number, number>): [slot: number, count: number] => {
    let best: [number, number] = [-1, 0];
    for (const [slot, n] of counts) if (n > best[1] || (n === best[1] && slot < best[0])) best = [slot, n];
    return best;
  };
  const need = unitSlots.length * CHAT_UI.frameShare;
  const [d, inDistrict] = most(perDistrict);
  const district = inDistrict >= need ? districtAt(replica, d) : null;
  if (district) return { ref: district.ref, label: district.label };
  const [c, inCity] = most(perCity);
  const city = inCity >= need ? cityAt(replica, c) : null;
  return city ? { ref: city.ref, label: city.label } : null;
}

export function select(args: Args, env: ToolEnv): ToolOutcome {
  const { replica } = env;
  const units = replica.table('unit');
  const paths = (args.paths as string[] | undefined) ?? [];
  const areaArg = args.area as string | undefined;
  const langArg = args.language as string | undefined;
  const mode = (args.mode as 'replace' | 'add' | undefined) ?? 'replace';
  if (paths.length === 0 && areaArg === undefined && langArg === undefined) {
    return fail('Nothing to select: give "paths", an "area", or both. To deselect, use clear_selection.');
  }

  const languages = mapLanguages(replica);
  const language = langArg === undefined ? null : findLanguage(languages, langArg);
  if (langArg !== undefined && !language) {
    return fail(`No files of language "${langArg}" on the map.`, { languages: languages.map((l) => l.id) });
  }
  let area: AreaHit | null = null;
  if (areaArg !== undefined) {
    area = findArea(replica, areaArg);
    if (!area) return fail(`No city or district is called "${areaArg}".`, { nearest: suggestAreas(replica, areaArg) });
  }

  const slots = new Set<number>();
  const skipped: { path: string; why: string; nearest?: string[] }[] = [];
  for (const raw of paths) {
    const hit = findFile(replica, raw);
    if (!hit) skipped.push({ path: cleanPath(raw), why: 'not on the map', nearest: suggestFiles(replica, raw, 3) });
    else if (hit.unitSlot < 0) skipped.push({ path: hit.path, why: 'has no sphere on the map' });
    else slots.add(hit.unitSlot);
  }
  if (area) for (const s of unitsIn(replica, area)) slots.add(s);
  // a language alone means every file of it, wherever it is
  if (!area && paths.length === 0) for (const s of units.slots()) slots.add(s);

  let chosen = [...slots];
  let otherLanguage = 0;
  if (language) {
    const before = chosen.length;
    chosen = chosen.filter((s) => (units.cols.lang[s] || 'other') === language.id);
    otherLanguage = before - chosen.length;
  }
  if (chosen.length === 0) {
    const why = language && otherLanguage > 0
      ? `None of those files is ${language.name}.`
      : paths.length > 0 && !area ? 'None of those paths is a file on the map.' : `${area?.label ?? 'That area'} holds no files.`;
    return fail(`${why} The selection was not changed.`, skipped.length ? { skipped } : {});
  }
  // most important first, so a cut keeps the files worth seeing and the selection pills lead with them
  chosen.sort((a, b) => (units.cols.importancePct[b] ?? 0) - (units.cols.importancePct[a] ?? 0) || a - b);
  const cut = Math.max(0, chosen.length - CHAT_UI.selectionMax);
  if (cut > 0) chosen = chosen.slice(0, CHAT_UI.selectionMax);

  const refs = chosen.map((s) => unitRef(units.ids[s]!));
  if (mode === 'add') env.act.addToSelection(refs); else env.act.setSelection(refs);

  const frame = frameFor(replica, chosen);
  const flew = frame ? env.act.flyTo(frame.ref) : env.act.showWholeMap();

  const kind = language ? `${language.name} ` : '';
  const what = chosen.length === 1 ? units.ids[chosen[0]!]! : `${plural(chosen.length, `${kind}file`, `${kind}files`)}`;
  const where = area && chosen.length > 1 ? ` in ${area.label}` : '';
  const action = mode === 'add' ? `Added ${what}${where} to the selection` : `Selected ${what}${where}`;
  return ok({
    selected: chosen.length,
    selectionSize: env.view().selection.length,
    ...(flew ? { framed: frame ? frame.label : 'the whole map' } : {}),
    ...(otherLanguage > 0 && language ? { leftOut: `${plural(otherLanguage, 'file', 'files')} that ${otherLanguage === 1 ? 'is' : 'are'} not ${language.name}` } : {}),
    ...(cut > 0 ? { cut: `${plural(cut, 'less important file', 'less important files')} left out: at most ${CHAT_UI.selectionMax} are selected at once` } : {}),
    ...(skipped.length ? { skipped } : {}),
  }, action);
}

export function clearSelection(_args: Args, env: ToolEnv): ToolOutcome {
  const count = env.view().selection.length;
  if (count === 0) return ok({ note: 'Nothing was selected.' });
  env.act.clearSelection();
  return ok({ deselected: count }, 'Cleared the selection');
}

export function focusOn(args: Args, env: ToolEnv): ToolOutcome {
  const { replica } = env;
  const raw = (args.target as string).trim();
  const isRef = /^[cd]:/.test(raw);
  const file = isRef ? null : findFile(replica, raw);
  let ref: NodeRef | null = null, label = '';
  if (file) {
    if (!file.ref) return fail(`${file.path} has no sphere on the map to fly to.`);
    ref = file.ref;
    label = file.path;
  } else {
    const area = findArea(replica, raw);
    if (area) { ref = area.ref; label = area.label; }
  }
  if (!ref) {
    return fail(`Nothing on the map is called "${raw}".`, isRef
      ? { nearest: suggestAreas(replica, raw) }
      : { nearestFiles: suggestFiles(replica, raw), nearestAreas: suggestAreas(replica, raw, 3) });
  }
  if (!env.act.flyTo(ref)) return fail('The map is not on screen yet, so the camera cannot move.');
  return ok({ flewTo: label }, `Flew to ${label}`);
}

export function openFile(args: Args, env: ToolEnv): ToolOutcome {
  const { replica } = env;
  const hit = findFile(replica, args.path as string);
  if (!hit) return fail(`No file "${cleanPath(args.path as string)}" on the map.`, { nearest: suggestFiles(replica, args.path as string) });
  env.act.openFile(hit.fileSlot >= 0 ? fileRef(hit.path) : hit.ref!);
  return ok({
    opened: hit.path,
    ...(env.content ? {} : { note: 'File contents are not available for this map, so the panel shows only that.' }),
  }, `Opened ${hit.path}`);
}
