// get_repo_overview, list_area, get_notes: the map at a glance, what is inside one area, and the AI
// notes already written. All read from the replica.
import type { ModelReplica } from '../../../contracts/store';
import type { Annotation, NodeRef } from '../../../model/types';
import { OVERLAYS, ownershipContributors } from '../../../overlays';
import { historyUnavailable, pillState } from '../../overlays/logic';
import type { ToolOutcome } from '../contract';
import { CHAT_UI } from '../tunables';
import { fail, limitOf, ok, type Args } from './args';
import type { ToolEnv } from './env';
import { cityAt, districtAt, findArea, mapLanguages, suggestAreas, unitsIn } from './lookup';

/** Importance as the tools report it: 0 to 1, two decimals. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

interface Tally { files: number; lines: number }

/** Files and lines per district slot and per city slot. */
function tallies(replica: ModelReplica): { district: Map<number, Tally>; city: Map<number, Tally> } {
  const units = replica.table('unit');
  const unitDistrict = units.refSlots.district ?? [];
  const districtCity = replica.table('district').refSlots.city ?? [];
  const district = new Map<number, Tally>(), city = new Map<number, Tally>();
  const add = (into: Map<number, Tally>, slot: number, lines: number) => {
    if (slot < 0) return;
    let t = into.get(slot);
    if (!t) into.set(slot, t = { files: 0, lines: 0 });
    t.files++;
    t.lines += lines;
  };
  for (let s = 0; s < units.capacity; s++) {
    if (units.ids[s] == null) continue;
    const d = unitDistrict[s] ?? -1;
    const lines = units.cols.loc[s] ?? 0;
    add(district, d, lines);
    add(city, d < 0 ? -1 : districtCity[d] ?? -1, lines);
  }
  return { district, city };
}

function summaries(annotations: readonly Annotation[]): Map<NodeRef, { label?: string; text: string }> {
  const out = new Map<NodeRef, { label?: string; text: string }>();
  for (const a of annotations) if (a.type === 'summary') out.set(a.parent, { label: a.label, text: a.text });
  return out;
}

/** The overlays on offer on this map, as the overlay pills decide it. */
export function overlaysOnOffer(env: ToolEnv): { id: string; label: string; ready: boolean }[] {
  const { replica } = env;
  const noHistory = historyUnavailable(env.view().noHistory, replica.meta?.source, env.hasFolder);
  const out: { id: string; label: string; ready: boolean }[] = [];
  for (const info of OVERLAYS) {
    const state = pillState(info, info.layer === null ? null : replica.layers.get(info.layer), noHistory);
    if (state.kind !== 'hidden') out.push({ id: info.id, label: info.label, ready: state.kind !== 'pending' });
  }
  return out;
}

export function getRepoOverview(_args: Args, env: ToolEnv): ToolOutcome {
  const { replica } = env;
  const meta = replica.meta;
  const units = replica.table('unit'), districts = replica.table('district');
  const tally = tallies(replica);
  const notes = summaries(replica.annotations);
  const districtCity = districts.refSlots.city ?? [];

  const cities = replica.table('city').slots().map((slot) => {
    const city = cityAt(replica, slot)!;
    const own = districts.slots().filter((d) => districtCity[d] === slot)
      .map((d) => ({ hit: districtAt(replica, d)!, files: tally.district.get(d)?.files ?? 0 }))
      .sort((a, b) => b.files - a.files);
    const shown = own.slice(0, CHAT_UI.overviewDistricts);
    const note = notes.get(city.ref);
    return {
      ref: city.ref, name: city.name,
      files: tally.city.get(slot)?.files ?? 0, lines: tally.city.get(slot)?.lines ?? 0,
      districts: shown.map((d) => ({ ref: d.hit.ref, name: d.hit.name, files: d.files })),
      ...(own.length > shown.length ? { moreDistricts: own.length - shown.length } : {}),
      ...(note ? { summary: note.text } : {}),
    };
  }).sort((a, b) => b.files - a.files);

  let lines = 0;
  for (const s of units.slots()) lines += units.cols.loc[s] ?? 0;
  const contributors = ownershipContributors(replica.layers.get('ownership'));

  return ok({
    repo: meta?.name ?? 'unknown',
    source: meta?.source ?? 'unknown',
    files: units.count,
    lines,
    links: replica.table('edge').count,
    languages: mapLanguages(replica).map((l) => ({ id: l.id, name: l.name, files: l.files, lines: l.lines })),
    cities,
    overlays: overlaysOnOffer(env).map((o) => (o.ready ? o.id : `${o.id} (no data yet)`)),
    ...(contributors.length > 0 ? {
      contributors: contributors.slice(0, CHAT_UI.overviewContributors).map((c) => ({ name: c.name, commits: c.commits })),
      ...(contributors.length > CHAT_UI.overviewContributors ? { moreContributors: contributors.length - CHAT_UI.overviewContributors } : {}),
    } : {}),
    ...(notes.size === 0 ? { note: 'No city summaries have been written yet.' } : {}),
  });
}

export function listArea(args: Args, env: ToolEnv): ToolOutcome {
  const { replica } = env;
  const raw = args.area as string;
  const area = findArea(replica, raw);
  if (!area) return fail(`No city or district is called "${raw}".`, { nearest: suggestAreas(replica, raw) });
  const limit = limitOf(args.limit, CHAT_UI.listDefault, CHAT_UI.listMax);
  const units = replica.table('unit');
  const note = summaries(replica.annotations).get(area.ref);

  if (area.kind === 'city') {
    const tally = tallies(replica);
    const districts = replica.table('district');
    const districtCity = districts.refSlots.city ?? [];
    const rows = districts.slots().filter((d) => districtCity[d] === area.slot)
      .map((d) => ({ ref: districtAt(replica, d)!.ref, name: districtAt(replica, d)!.name, files: tally.district.get(d)?.files ?? 0, lines: tally.district.get(d)?.lines ?? 0 }))
      .sort((a, b) => b.files - a.files);
    return ok({
      city: { ref: area.ref, name: area.name, files: tally.city.get(area.slot)?.files ?? 0, lines: tally.city.get(area.slot)?.lines ?? 0, ...(note ? { summary: note.text } : {}) },
      districts: rows.slice(0, limit),
      ...(rows.length > limit ? { cut: `${rows.length - limit} more districts not listed; raise limit to see them` } : {}),
    });
  }

  const slots = unitsIn(replica, area).sort((a, b) => (units.cols.importancePct[b] ?? 0) - (units.cols.importancePct[a] ?? 0) || a - b);
  const city = cityAt(replica, area.citySlot);
  return ok({
    district: { ref: area.ref, name: area.name, files: slots.length, ...(city ? { city: { ref: city.ref, name: city.name } } : {}) },
    files: slots.slice(0, limit).map((s) => ({
      path: units.ids[s]!, lang: units.cols.lang[s] ?? 'other', lines: units.cols.loc[s] ?? 0, importance: round2(units.cols.importancePct[s] ?? 0),
    })),
    ...(slots.length > limit ? { cut: `${slots.length - limit} less important files not listed; raise limit to see them` } : {}),
  });
}

export function getNotes(_args: Args, env: ToolEnv): ToolOutcome {
  const { replica } = env;
  const path = (ref: string): string => ref.slice(2);
  const areaName = (ref: NodeRef): string => findArea(replica, ref)?.label ?? ref;
  const out = {
    summaries: [] as { area: NodeRef; name: string; text: string }[],
    pointsOfInterest: [] as { path: string; label: string; kind: string; text: string; evidence?: string }[],
    tour: [] as { step: number; path: string; frames: string; text: string }[],
  };
  for (const a of replica.annotations) {
    if (a.type === 'summary') out.summaries.push({ area: a.parent, name: areaName(a.parent), text: a.text });
    else if (a.type === 'poi') out.pointsOfInterest.push({ path: path(a.parent), label: a.label, kind: a.kind, text: a.summary, ...(a.evidence ? { evidence: a.evidence } : {}) });
    else a.steps.forEach((step, i) => out.tour.push({ step: i + 1, path: path(step.parent), frames: step.frame, text: step.text }));
  }
  const empty = out.summaries.length + out.pointsOfInterest.length + out.tour.length === 0;
  return ok(empty ? { ...out, note: 'No AI notes have been written for this map yet.' } : out);
}
