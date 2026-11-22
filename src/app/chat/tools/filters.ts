// set_filters and reset_view: the legend's two filters (file types, minimum size) and the "Reset
// view" pill, as tools.
import { formatBytes } from '../../units';
import type { ToolOutcome } from '../contract';
import { fail, ok, type Args } from './args';
import type { ToolEnv } from './env';
import { findLanguage, mapLanguages, type MapLanguage } from './lookup';
import { bytesPerLine, hiddenBy, largestBytes } from './view';

/** "TypeScript", "TypeScript and Python", "TypeScript, Python and Go". */
function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function setFilters(args: Args, env: ToolEnv): ToolOutcome {
  const { replica } = env;
  const wanted = args.languages as string[] | undefined;
  const minLines = args.min_lines as number | undefined;
  if (wanted === undefined && minLines === undefined) return fail('Nothing to change: give "languages", "min_lines", or both.');
  if (minLines !== undefined && minLines < 0) return fail('"min_lines" must be 0 or more.');

  const onMap = mapLanguages(replica);
  const chosen: MapLanguage[] = [];
  if (wanted !== undefined) {
    const unknown: string[] = [];
    for (const raw of wanted) {
      const language = findLanguage(onMap, raw);
      if (!language) unknown.push(raw);
      else if (!chosen.includes(language)) chosen.push(language);
    }
    if (unknown.length > 0) {
      return fail(`No files of ${unknown.map((u) => `"${u}"`).join(', ')} on the map. Nothing was changed.`, { languages: onMap.map((l) => l.id) });
    }
  }

  const view = env.view();
  const result: Record<string, unknown> = {};
  const did: string[] = [];

  if (wanted !== undefined) {
    const ids = chosen.map((l) => l.id);
    const same = ids.length === view.typeFilter.length && ids.every((id) => view.typeFilter.includes(id));
    if (!same) {
      env.act.setTypeFilter(ids);
      did.push(ids.length === 0 ? 'Showing every language again' : `Dimmed everything except ${namesList(chosen.map((l) => l.name))}`);
    }
    result.languages = ids.length === 0 ? 'all' : ids;
  }

  if (minLines !== undefined) {
    // The size filter holds bytes. Lines become bytes at the map's own rate, and never past the
    // largest file, which is where the legend's slider ends.
    const bytes = minLines === 0 ? 0 : Math.min(largestBytes(replica), Math.round(minLines * bytesPerLine(replica)));
    if (bytes !== view.minBytes) {
      env.act.setMinBytes(bytes);
      did.push(bytes === 0 ? 'Showing files of every size again' : `Hid files under about ${minLines.toLocaleString('en-US')} lines (${formatBytes(bytes)})`);
    }
    result.minLines = minLines;
    result.minBytes = bytes;
    result.hiddenFiles = hiddenBy(replica, bytes);
    result.ofFiles = replica.table('unit').count;
    if (bytes > 0) result.note = 'The size filter works in bytes, so the cut is approximate; the most important files stay visible whatever their size.';
  }

  if (did.length === 0) return ok({ ...result, unchanged: 'The filters were already set that way.' });
  return ok(result, did.join('; ').replace(/; ([A-Z])/g, (_, c: string) => `; ${c.toLowerCase()}`));
}

export function resetView(_args: Args, env: ToolEnv): ToolOutcome {
  if (!env.act.resetView()) return fail('The map is not on screen yet, so there is nothing to reset.');
  return ok({ note: 'The camera shows the whole map and every city and district is back in place. The selection, the overlay and the filters were left as they were.' }, 'Reset the view');
}
