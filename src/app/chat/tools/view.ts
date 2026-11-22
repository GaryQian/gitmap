// get_view_state: what the user is looking at now. Also the arithmetic between lines (what the model
// speaks) and bytes (what the size filter holds), which set_filters shares.
import { config } from '../../../config';
import type { ModelReplica } from '../../../contracts/store';
import { parseRef } from '../../../model/types';
import { OVERLAYS, ownershipContributors } from '../../../overlays';
import { hiddenCount } from '../../legend/slider';
import type { ToolOutcome } from '../contract';
import { CHAT_UI } from '../tunables';
import { ok, type Args } from './args';
import type { ToolEnv } from './env';
import { findArea, mapLanguages } from './lookup';

/** Bytes per line across the map: the size filter is in bytes, and this is the rate to change lines into it. */
export function bytesPerLine(replica: ModelReplica): number {
  const units = replica.table('unit');
  let bytes = 0, lines = 0;
  for (let s = 0; s < units.capacity; s++) {
    if (units.ids[s] == null || !(units.cols.loc[s]! > 0)) continue;
    bytes += units.cols.bytes[s] ?? 0;
    lines += units.cols.loc[s]!;
  }
  return lines > 0 && bytes > 0 ? bytes / lines : 40;
}

export function largestBytes(replica: ModelReplica): number {
  const units = replica.table('unit');
  let max = 0;
  for (let s = 0; s < units.capacity; s++) if (units.ids[s] != null && units.cols.bytes[s]! > max) max = units.cols.bytes[s]!;
  return max;
}

/** How many files a size threshold hides (files that glow are exempt, as on the legend). */
export function hiddenBy(replica: ModelReplica, minBytes: number): number {
  const units = replica.table('unit');
  const bytes: number[] = [], importance: number[] = [];
  for (let s = 0; s < units.capacity; s++) {
    if (units.ids[s] == null) continue;
    bytes.push(units.cols.bytes[s] ?? 0);
    importance.push(units.cols.importancePct[s] ?? 0);
  }
  return hiddenCount(bytes, importance, minBytes, config.visual);
}

const overlayLabel = (id: string): string => OVERLAYS.find((o) => o.id === id)?.label ?? id;

export function getViewState(_args: Args, env: ToolEnv): ToolOutcome {
  const { replica } = env;
  const view = env.view();

  const files: string[] = [], areas: { ref: string; name: string }[] = [];
  for (const ref of view.selection) {
    let parsed;
    try { parsed = parseRef(ref); } catch { continue; }
    if (parsed.kind === 'unit' || parsed.kind === 'file') files.push(parsed.id);
    else { const area = findArea(replica, ref); if (area) areas.push({ ref, name: area.label }); }
  }

  let overlay: Record<string, unknown> | null = null;
  if (view.activeOverlay !== null) {
    overlay = { id: view.activeOverlay, name: overlayLabel(view.activeOverlay) };
    if (view.activeOverlay === 'ownership') {
      const contributors = ownershipContributors(replica.layers.get('ownership'));
      const shown = contributors.find((c) => c.id === view.contributorId) ?? contributors[0];
      if (shown) overlay.contributor = shown.name;
    }
    if (view.activeOverlay === 'reach') {
      overlay.direction = view.direction === 'dependsOn' ? 'depends_on' : 'depended_on_by';
      if (Number.isFinite(view.maxHops)) overlay.maxHops = view.maxHops;
      if (view.selection.length === 0) overlay.note = 'Nothing is selected, so the overlay has nothing to start from.';
    }
  }

  const languages = mapLanguages(replica);
  const total = replica.table('unit').count;
  const idOf = (ref: string | null): string | null => (ref === null ? null : ref.slice(2));
  return ok({
    overlay,
    selection: {
      count: view.selection.length,
      files: files.slice(0, CHAT_UI.viewSelection),
      ...(files.length > CHAT_UI.viewSelection ? { moreFiles: files.length - CHAT_UI.viewSelection } : {}),
      ...(areas.length ? { areas } : {}),
    },
    detailCardOn: idOf(view.focus),
    languageFilter: view.typeFilter.length === 0
      ? 'all languages'
      : view.typeFilter.map((id) => languages.find((l) => l.id === id)?.id ?? id),
    sizeFilter: view.minBytes > 0
      ? { minBytes: view.minBytes, aboutLines: Math.round(view.minBytes / bytesPerLine(replica)), hiddenFiles: hiddenBy(replica, view.minBytes), ofFiles: total }
      : 'files of every size',
    openFile: idOf(view.openFile),
    sidePanel: view.panel ?? 'closed',
  });
}
