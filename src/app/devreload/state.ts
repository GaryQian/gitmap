// Development only: what the dev server held back while a map was open (scripts/holdReloads.ts), and
// the "Reopen" offer for a folder whose permission did not survive a reload (devResume.ts).
import { useSyncExternalStore } from 'react';

export interface ReopenOffer { name: string; reopen: () => Promise<void> }
interface DevReloadState { held: number; offer: ReopenOffer | null }

let state: DevReloadState = { held: 0, offer: null };
const listeners = new Set<() => void>();
function set(patch: Partial<DevReloadState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useDevReload(): DevReloadState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Ask the dev server to hold back reloads for this tab (a map is loading or open), or to stop. */
export function setHold(hold: boolean): void {
  import.meta.hot?.send('starmap:hold', { hold });
  if (!hold) set({ held: 0 });
}

export function setReopenOffer(offer: ReopenOffer | null): void { set({ offer }); }

if (import.meta.hot) {
  import.meta.hot.on('starmap:held', () => set({ held: state.held + 1 }));
  // This module holds state. Hot-swapping it would leave two copies alive, so reload the page instead.
  import.meta.hot.accept(() => location.reload());
}
