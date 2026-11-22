// The overlay feature's own small store: the parameters of the parametric overlays, and whether the
// open session has said that history is unavailable. The active overlay itself lives in the app store.
import { create } from 'zustand';
import type { OverlayViewInfo, ReachDirection } from '../../overlays';
import { useApp, type ShownNotice } from '../store';

export interface OverlayParams {
  /** Ownership: whose share to show; null = the contributor with the most commits. */
  contributorId: number | null;
  /** Dependency reach: which way to walk from the selection. */
  direction: ReachDirection;
  /** Dependency reach: how many hops to walk; Infinity = all the way. */
  maxHops: number;
  /** Recency: leave out files that changed more than this many seconds before the newest one; Infinity = every file. */
  maxAgeSeconds: number;
  /** The active overlay's view as last handed to the renderer, for the hover tooltip; null when none is on. */
  shown: OverlayViewInfo | null;
  /** The session raised a 'no-history' notice. Kept after the notice is dismissed. */
  noHistory: boolean;
}

const noticed = (notices: readonly ShownNotice[]): boolean => notices.some((n) => n.kind === 'no-history');

export const useOverlayParams = create<OverlayParams>()(() => ({
  contributorId: null,
  direction: 'dependsOn',
  maxHops: Infinity,
  maxAgeSeconds: Infinity,
  shown: null,
  noHistory: noticed(useApp.getState().notices),
}));

export function setContributor(contributorId: number | null): void { useOverlayParams.setState({ contributorId }); }
export function setDirection(direction: ReachDirection): void { useOverlayParams.setState({ direction }); }
export function setMaxHops(maxHops: number): void { useOverlayParams.setState({ maxHops }); }
export function setMaxAge(maxAgeSeconds: number): void { useOverlayParams.setState({ maxAgeSeconds }); }

// A new map starts with its own top contributor, every age shown and no word about history; the
// direction and the hop limit are a viewer's habit and stay.
const unsubscribe = useApp.subscribe((s, prev) => {
  if (s.session !== prev.session) useOverlayParams.setState({ contributorId: null, maxAgeSeconds: Infinity, noHistory: noticed(s.notices) });
  else if (s.notices !== prev.notices && noticed(s.notices) && !useOverlayParams.getState().noHistory) useOverlayParams.setState({ noHistory: true });
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);
