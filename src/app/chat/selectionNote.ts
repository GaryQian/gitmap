// What is selected on the map, as the assistant is told it. The model cannot see the map, so every
// question goes out with a short note in front of it naming the cities, districts and files that
// were selected at that moment (state.ts). The note is part of the message the model reads, never
// of the transcript the person sees; the line over the composer says the same thing to them.
import type { ModelReplica } from '../../contracts/store';
import { parseRef, type NodeRef } from '../../model/types';
import { cityAt, findArea, findFile, unitsIn } from './tools/lookup';
import { CHAT_UI } from './tunables';

/** The tag around the note. The system prompt (src/ai/server/chatPrompt.ts) names it too. */
export const SELECTION_TAG = 'map_selection';

export interface SelectedArea {
  ref: NodeRef;
  kind: 'city' | 'district';
  name: string;
  /** A district's city. */
  city?: string;
  files: number;
}

export interface SelectionFacts {
  /** Selected cities and districts, in the order they were selected. */
  areas: SelectedArea[];
  /** Paths of the selected files, in the order they were selected. */
  files: string[];
}

/** The selection sorted into areas and files. Refs that no longer exist are left out. */
export function selectionFacts(replica: ModelReplica, selection: readonly NodeRef[]): SelectionFacts {
  const areas: SelectedArea[] = [], files: string[] = [];
  for (const ref of selection) {
    let kind: ReturnType<typeof parseRef>['kind'], id: string;
    try { ({ kind, id } = parseRef(ref)); } catch { continue; }
    if (kind === 'unit' || kind === 'file') {
      if (findFile(replica, id)) files.push(id);
      continue;
    }
    const area = findArea(replica, ref);
    if (!area) continue;
    const city = area.kind === 'district' ? cityAt(replica, area.citySlot)?.name : undefined;
    areas.push({ ref: area.ref, kind: area.kind, name: area.name, ...(city ? { city } : {}), files: unitsIn(replica, area).length });
  }
  return { areas, files };
}

const count = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * The note that goes in front of a question, or '' when nothing is selected and nothing needs
 * saying. `sayEmpty`: an earlier message of the conversation carried a selection, so an empty one
 * is said outright, or the model would go on assuming the old one.
 */
export function selectionNote(replica: ModelReplica, selection: readonly NodeRef[], opts: { sayEmpty?: boolean } = {}): string {
  const { areas, files } = selectionFacts(replica, selection);
  const open = `<${SELECTION_TAG}>`, close = `</${SELECTION_TAG}>`;
  if (areas.length === 0 && files.length === 0) {
    return opts.sayEmpty ? `${open}\nNothing is selected on the map now.\n${close}` : '';
  }
  const lines: string[] = ['Selected on the map when this message was sent (added by the app, not typed by the person):'];
  for (const a of areas.slice(0, CHAT_UI.noteAreas)) {
    const where = a.kind === 'city' ? `city "${a.name}"` : a.city ? `district "${a.name}" in city "${a.city}"` : `district "${a.name}"`;
    lines.push(`- ${where} (ref ${a.ref}), ${count(a.files, 'file', 'files')}`);
  }
  if (areas.length > CHAT_UI.noteAreas) lines.push(`- and ${count(areas.length - CHAT_UI.noteAreas, 'more city or district', 'more cities and districts')}`);
  for (const path of files.slice(0, CHAT_UI.noteFiles)) lines.push(`- file \`${path}\``);
  if (files.length > CHAT_UI.noteFiles) lines.push(`- and ${count(files.length - CHAT_UI.noteFiles, 'more file', 'more files')} (get_view_state lists them)`);
  return `${open}\n${lines.join('\n')}\n${close}`;
}

/** A question as the model is sent it: the note, then the person's own words. */
export function withSelection(question: string, note: string): string {
  return note === '' ? question : `${note}\n\n${question}`;
}

/** Whether a message that was sent carries a selection note. */
export const hasSelectionNote = (text: string): boolean => text.includes(`<${SELECTION_TAG}>`);

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * The selection in a few words, for the line over the composer: "Runtime gateway", "agents and 3
 * files", "2 cities and districts and 14 files". Null when nothing is selected.
 */
export function selectionPhrase({ areas, files }: SelectionFacts): string | null {
  const parts: string[] = [];
  if (areas.length > 0 && areas.length <= 2) parts.push(...areas.map((a) => a.name));
  else if (areas.length > 2) {
    const cities = areas.filter((a) => a.kind === 'city').length;
    parts.push(cities === areas.length ? `${cities} cities` : cities === 0 ? `${areas.length} districts` : `${areas.length} cities and districts`);
  }
  if (files.length === 1) parts.push(baseName(files[0]!));
  else if (files.length > 1) parts.push(count(files.length, 'file', 'files'));
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}
