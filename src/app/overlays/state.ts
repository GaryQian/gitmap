// The overlay feature's own small store: the parameters of the parametric overlays, and whether the
// open session has said that history is unavailable. The active overlay itself lives in the app store.
import { create } from 'zustand';
import type { ReachDirection } from '../../overlays';
import { useApp, type ShownNotice } from '../store';

export interface OverlayParams {
  /** Ownership: whose share to show; null = the contributor with the most commits. */
  contributorId: number | null;
  /** Dependency reach: which way to walk from the selection. */
  direction: ReachDirection;
  /** The session raised a 'no-history' notice. Kept after the notice is dismissed. */
  noHistory: boolean;
}

const noticed = (notices: readonly ShownNotice[]): boolean => notices.some((n) => n.kind === 'no-history');

export const useOverlayParams = create<OverlayParams>()(() => ({
  contributorId: null,
  direction: 'dependsOn',
  noHistory: noticed(useApp.getState().notices),
}));

export function setContributor(contributorId: number | null): void { useOverlayParams.setState({ contributorId }); }
export function setDirection(direction: ReachDirection): void { useOverlayParams.setState({ direction }); }

// A new map starts with its own top contributor and no word about history; the direction is a
// viewer's habit and stays.
const unsubscribe = useApp.subscribe((s, prev) => {
  if (s.session !== prev.session) useOverlayParams.setState({ contributorId: null, noHistory: noticed(s.notices) });
  else if (s.notices !== prev.notices && noticed(s.notices) && !useOverlayParams.getState().noHistory) useOverlayParams.setState({ noHistory: true });
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);
