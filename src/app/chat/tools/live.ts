// The tools' view of the open map, built from the app's stores at the moment of each call. Every
// action is the one the user's own control calls: the store's selection and filter actions, the
// overlay feature's parameters, the renderer's flights, the layout reset of the "Reset view" pill.
import type { NodeRef } from '../../../model/types';
import { setContributor, setDirection, useOverlayParams } from '../../overlays/state';
import {
  addToSelection, clearSelection, setActiveOverlay, setMinBytes, setOpenFile, setSelection, setTypeFilter, useApp,
} from '../../store';
import { showFileTab, usePanel } from '../panel';
import type { ToolEnv } from './env';

/** A renderer or physics method may still be a stub, or the renderer disposed: a tool must survive either. */
function attempt(fn: () => void): boolean {
  try { fn(); return true; } catch (err) { console.warn('starmap: the chat could not reach the map', err); return false; }
}

/** Counts resets, so a superseded one does not fly a second time. */
let resets = 0;

export function liveEnv(): ToolEnv | null {
  const { session } = useApp.getState();
  if (!session) return null;
  const flight = () => (useApp.getState().reducedMotion ? { ms: 0 } : undefined);
  const renderer = () => (useApp.getState().session === session ? useApp.getState().render : null);

  return {
    replica: session.replica,
    config: session.config,
    hasFolder: session.source.kind === 'directory' || (session.source.kind === 'snapshot' && session.source.locator !== undefined),
    search: (query, limit) => session.search(query, limit),
    get content() { return session.content; },
    view() {
      const app = useApp.getState();
      const overlay = useOverlayParams.getState();
      const tab = usePanel.getState().tab;
      return {
        selection: app.selection, focus: app.focus, activeOverlay: app.activeOverlay, typeFilter: app.typeFilter,
        minBytes: app.minBytes, openFile: app.openFile,
        contributorId: overlay.contributorId, direction: overlay.direction, maxHops: overlay.maxHops, noHistory: overlay.noHistory,
        panel: tab === 'chat' ? 'chat' : app.openFile ? 'file' : null,
      };
    },
    act: {
      setSelection, addToSelection, clearSelection, setActiveOverlay, setContributor, setDirection, setTypeFilter, setMinBytes,
      openFile(ref: NodeRef) {
        setOpenFile(ref);
        showFileTab(); // also when that file was already the open one
      },
      flyTo(ref) {
        const render = renderer();
        // nothing waits on the flight: the renderer drops one in progress when the next starts
        return render !== null && attempt(() => { void render.flyTo(ref, flight()).catch(() => {}); });
      },
      showWholeMap() {
        const render = renderer();
        return render !== null && attempt(() => { void render.resetView(flight()).catch(() => {}); });
      },
      resetView() {
        const render = renderer();
        if (!render) return false;
        const mine = ++resets;
        return attempt(() => {
          const camera = render.resetView(flight()).catch(() => {});
          const layout = session.physics.resetLayout().catch((err: unknown) => console.warn('starmap: resetLayout failed', err));
          // The default framing depends on where the cities are, and they were still on their way
          // home when the camera set off: once both have arrived, fly the last bit if it has moved.
          void Promise.all([camera, layout]).then(() => {
            if (mine !== resets || renderer() !== render) return;
            const off = render.on('frame', () => {
              off();
              if (mine === resets && !render.isDefaultView()) void render.resetView(flight()).catch(() => {});
            });
          }).catch(() => {});
        });
      },
    },
  };
}
