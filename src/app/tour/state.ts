// The tour's own small store: the sequencing state from sequence.ts, and a counter that says when
// the camera should fly. Actions are plain functions, like the ones in ../store.
import { create } from 'zustand';
import type { Tour } from '../../model/types';
import { NO_TOUR, currentStep, goTo, next, prev, start, stop, tourChanged, type TourState } from './sequence';

interface TourStore {
  seq: TourState;
  /**
   * Goes up each time the camera should fly to the step on screen: when the user starts or steps,
   * and when a changed tour puts a different file or framing there. It does not go up when the model changes
   * around a step that stays, so a camera the user has dragged away is left alone.
   */
  flight: number;
}

export const useTour = create<TourStore>()(() => ({ seq: NO_TOUR, flight: 0 }));

/** Run a transition the user asked for. Any step it lands on is flown to. */
function navigate(change: (state: TourState) => TourState): void {
  useTour.setState((s) => {
    const seq = change(s.seq);
    if (seq === s.seq) return s;
    return { seq, flight: seq.active ? s.flight + 1 : s.flight };
  });
}

export function startTour(): void { navigate(start); }
/** The next step; on the last one this finishes the tour. */
export function nextStep(): void { navigate(next); }
export function prevStep(): void { navigate(prev); }
/** The next step, but never past the last: for the keyboard, where a held key must not end the tour. */
export function stepForward(): void { navigate((s) => goTo(s, s.index + 1)); }
export function stopTour(): void { navigate(stop); }

/** Show step `index`. Asking for the step already showing flies back to it. */
export function goToStep(index: number): void {
  useTour.setState((s) => {
    if (!s.seq.active) return s;
    if (index === s.seq.index) return { seq: s.seq, flight: s.flight + 1 };
    const seq = goTo(s.seq, index);
    return seq === s.seq ? s : { seq, flight: s.flight + 1 };
  });
}

/** The tour the replica offers changed (or there is none any more). */
export function offerTour(tour: Tour | null): void {
  useTour.setState((s) => {
    const seq = tourChanged(s.seq, tour);
    if (seq === s.seq) return s;
    const now = currentStep(seq), was = currentStep(s.seq);
    const moved = seq.active && (now?.parent !== was?.parent || now?.frame !== was?.frame);
    return { seq, flight: moved ? s.flight + 1 : s.flight };
  });
}

// This module holds state. Hot-swapping it would leave two copies alive, so reload the page instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
