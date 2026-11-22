// Tour sequencing: which step is showing, and what becomes of it when the tour or the model changes.
// Pure: no React, no renderer. state.ts runs these transitions and mount.tsx draws the result.
// Every transition returns the state it was given when nothing changes.
import type { ModelReplica } from '../../contracts/store';
import { cityRef, districtRef, parseRef, type NodeRef, type Tour, type TourStep } from '../../model/types';

export interface TourState {
  /** The tour on offer, already reduced to its valid steps (see `offeredTour`). Null when there is none. */
  tour: Tour | null;
  /** The step showing while the tour is active; 0 otherwise. */
  index: number;
  active: boolean;
}

export const NO_TOUR: TourState = { tour: null, index: 0, active: false };

export function stepCount(state: TourState): number {
  return state.tour?.steps.length ?? 0;
}

/** The step on screen, or null when no tour is playing. */
export function currentStep(state: TourState): TourStep | null {
  return state.active ? state.tour?.steps[state.index] ?? null : null;
}

export function isLastStep(state: TourState): boolean {
  return state.active && state.index === stepCount(state) - 1;
}

/** Begin at the first step. Nothing happens without a tour, or while one is already playing. */
export function start(state: TourState): TourState {
  if (state.active || stepCount(state) === 0) return state;
  return { tour: state.tour, index: 0, active: true };
}

/** End the tour. The next start begins at the first step again. */
export function stop(state: TourState): TourState {
  if (!state.active && state.index === 0) return state;
  return { tour: state.tour, index: 0, active: false };
}

/** Show step `index`. Out of range, or not playing: nothing happens. */
export function goTo(state: TourState, index: number): TourState {
  if (!state.active || !Number.isInteger(index) || index < 0 || index >= stepCount(state) || index === state.index) return state;
  return { tour: state.tour, index, active: true };
}

/** The next step; on the last step this finishes the tour. */
export function next(state: TourState): TourState {
  if (!state.active) return state;
  return isLastStep(state) ? stop(state) : goTo(state, state.index + 1);
}

/** The previous step; the first step stays where it is. */
export function prev(state: TourState): TourState {
  return goTo(state, state.index - 1);
}

/**
 * The tour on offer was regenerated, lost steps, or went away.
 * - No tour (null, or no steps): whatever was playing stops.
 * - Not playing: the new tour simply replaces the old one.
 * - Playing: the step on screen is looked for in the new tour. Found (the same parent and text
 *   anywhere, or the same parent at the same position), the tour carries on from there; otherwise
 *   it restarts at the first step.
 */
export function tourChanged(state: TourState, tour: Tour | null): TourState {
  if (!tour || tour.steps.length === 0) return state.tour === null && !state.active && state.index === 0 ? state : NO_TOUR;
  if (state.tour && sameTour(state.tour, tour)) return state;
  if (!state.active) return { tour, index: 0, active: false };
  const shown = currentStep(state);
  let at = shown ? tour.steps.findIndex((s) => s.parent === shown.parent && s.text === shown.text) : -1;
  if (at < 0 && shown && tour.steps[state.index]?.parent === shown.parent) at = state.index;
  return { tour, index: Math.max(0, at), active: true };
}

function sameRefs(a: readonly NodeRef[], b: readonly NodeRef[]): boolean {
  return a.length === b.length && a.every((ref, i) => ref === b[i]);
}

/** Two tours that would look and behave the same on screen. */
export function sameTour(a: Tour, b: Tour): boolean {
  if (a === b) return true;
  return a.id === b.id && a.steps.length === b.steps.length && a.steps.every((s, i) => {
    const t = b.steps[i]!;
    return s === t || (s.parent === t.parent && s.frame === t.frame && s.text === t.text && sameRefs(s.highlights, t.highlights));
  });
}

/** Whether a ref is a `u:` ref to a unit the replica holds right now. Anything else, or malformed, is not. */
export function unitExists(replica: ModelReplica, ref: NodeRef): boolean {
  try {
    const { kind, id } = parseRef(ref);
    return kind === 'unit' && replica.table('unit').has(id);
  } catch {
    return false;
  }
}

/**
 * The steps of a tour that can still be shown: a step whose `parent` unit no longer exists is
 * dropped, and highlights that no longer exist are dropped from the steps that stay. `enough` says
 * whether at least `min` steps remain (default 1: a tour is offered as long as there is somewhere to go).
 */
export function stepsValid(tour: Tour, replica: ModelReplica, min = 1): { steps: TourStep[]; enough: boolean } {
  const steps: TourStep[] = [];
  for (const step of tour.steps) {
    if (!unitExists(replica, step.parent)) continue;
    const highlights = step.highlights.filter((ref) => unitExists(replica, ref));
    steps.push(highlights.length === step.highlights.length ? step : { ...step, highlights });
  }
  return { steps, enough: steps.length >= Math.max(1, min) };
}

/**
 * What the camera frames for a step, looked up now: the step's file, or the district or city that
 * file belongs to at this moment (PLAN.md §11.3), so a step about a city still works after the
 * clustering changes. A file without a district is framed on its own; null when the file is gone.
 */
export function frameTarget(step: TourStep, replica: ModelReplica): NodeRef | null {
  if (!unitExists(replica, step.parent)) return null;
  if (step.frame !== 'district' && step.frame !== 'city') return step.parent;
  const units = replica.table('unit');
  const district = units.cols.district[units.slotOf(parseRef(step.parent).id)];
  if (!district) return step.parent;
  if (step.frame === 'district') return districtRef(district);
  const districts = replica.table('district');
  const city = districts.cols.city[districts.slotOf(district)];
  return city ? cityRef(city) : districtRef(district);
}

/**
 * The tour to offer for this replica: the most recent `tour` annotation with enough valid steps,
 * holding only those steps. Null when there is none.
 */
export function offeredTour(replica: ModelReplica, min = 1): Tour | null {
  for (let i = replica.annotations.length - 1; i >= 0; i--) {
    const a = replica.annotations[i]!;
    if (a.type !== 'tour') continue;
    const { steps, enough } = stepsValid(a, replica, min);
    if (!enough) continue;
    return steps.length === a.steps.length && steps.every((s, k) => s === a.steps[k]) ? a : { ...a, steps };
  }
  return null;
}
