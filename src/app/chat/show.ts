// Carrying out autoshow.ts: after a finished answer that names files the assistant did not point at,
// select them and bring them into view, and say so in one line. Also the watch that tells whether
// the user took the view somewhere themselves while the answer was being written.
import type { Session } from '../../contracts/pipeline';
import type { NodeRef } from '../../model/types';
import { useApp } from '../store';
import { planShow, showLine, type ShowFacts } from './autoshow';
import { resolveMention } from './paths';
import { liveEnv } from './tools/live';
import { findFile } from './tools/lookup';
import { frameFor } from './tools/selection';

/**
 * Where a press or a turn of the wheel moves the camera or the layout: the map itself, the pills
 * and cards in the scene, the "Reset view" pill, the tour. Typing in the side panel, or turning an
 * overlay on, is not moving the map; a search result or a selection pill changes the selection,
 * which is compared as well.
 */
const MAP_CONTROLS = 'canvas.gm-map-canvas, .gm-region-scene, .gm-reset, .gm-tour-pill, .gm-tour-card';

export interface UserWatch {
  /** The assistant's own tools have just changed the view: what the selection is now is the new baseline. */
  sync(): void;
  /** The user moved the camera or changed the selection since the watch began. When in doubt, true. */
  moved(): boolean;
  stop(): void;
}

export function watchUser(): UserWatch {
  let selection = useApp.getState().selection;
  let acted = false;
  const onPointer = (e: Event) => {
    if (e.target instanceof Element && e.target.closest(MAP_CONTROLS)) acted = true;
  };
  const onKey = (e: KeyboardEvent) => {
    // Home resets the view; the arrow keys step a playing tour. Neither means anything typed into a field.
    const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    if (!typing && (e.key === 'Home' || (document.querySelector('.gm-tour-card') !== null && /^Arrow|^ $/.test(e.key)))) acted = true;
  };
  const listening = typeof window !== 'undefined';
  if (listening) {
    // capture: the map canvas takes pointer events for itself
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('wheel', onPointer, { capture: true, passive: true });
    window.addEventListener('keydown', onKey, true);
  }
  return {
    sync() { selection = useApp.getState().selection; },
    moved: () => acted || useApp.getState().selection !== selection,
    stop() {
      if (!listening) return;
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('wheel', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    },
  };
}

/**
 * Show what a finished answer references, unless there is a reason not to (autoshow.ts). Returns
 * the line for the transcript, or undefined when the map was left alone.
 */
export function showReferenced(session: Session, facts: Omit<ShowFacts, 'resolve'>): string | undefined {
  const env = liveEnv();
  if (!env || env.replica !== session.replica) return undefined;
  const { replica } = env;
  const plan = planShow({ ...facts, resolve: (text) => resolveMention(replica, text) });
  if (plan.kind === 'none') return undefined;

  // one sphere may hold two of the files (a header and its implementation): select it once
  const slots: number[] = [], refs: NodeRef[] = [], paths: string[] = [];
  for (const path of plan.kind === 'one' ? [plan.path] : plan.paths) {
    const hit = findFile(replica, path);
    if (!hit?.ref || hit.unitSlot < 0 || slots.includes(hit.unitSlot)) continue;
    slots.push(hit.unitSlot);
    refs.push(hit.ref);
    paths.push(hit.path);
  }
  if (refs.length === 0) return undefined;

  env.act.setSelection(refs);
  if (refs.length === 1) {
    env.act.flyTo(refs[0]!);
    return showLine(1, paths[0]!, null);
  }
  // the district or city that holds most of them; scattered across the map, the first one mentioned
  const frame = frameFor(replica, slots);
  env.act.flyTo(frame ? frame.ref : refs[0]!);
  return showLine(refs.length, paths[0]!, frame ? frame.label : null);
}
