// Drives the renderer: builds the active overlay's view and hands it to `render.setOverlay`
// (PLAN.md §3.1, §10). The view is rebuilt at once when the viewer changes something (the overlay,
// a parameter, the theme, the selection for Dependency reach) and at most a few times a second while
// layer chunks stream in; the renderer cross-fades between views.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelReplica } from '../../contracts/store';
import type { NodeRef } from '../../model/types';
import { buildAdjacency, overlayView, type Adjacency, type OverlayContext, type OverlayInfo, type OverlayViewInfo } from '../../overlays';
import { useApp, useRender, useSelection, useThemeMode } from '../store';
import { batchTouches, seedSlots, touchesOverlay } from './logic';
import { useOverlayParams } from './state';
import { OVERLAY_UI } from './tunables';

const NO_SEEDS: readonly number[] = [];
const NO_SELECTION: readonly NodeRef[] = [];

export interface ActiveOverlay {
  view: OverlayViewInfo | null;
  /** Dependency reach: the unit slots it starts from (empty for the other overlays). */
  seeds: readonly number[];
}

/**
 * The view of the active overlay, kept on the renderer. `contributorId` is the Ownership choice
 * (undefined = the top contributor).
 */
export function useOverlayView(active: OverlayInfo | null, contributorId: number | undefined): ActiveOverlay {
  const replica = useApp((s) => s.session?.replica ?? null);
  const render = useRender();
  const mode = useThemeMode();
  const selection = useSelection();
  const direction = useOverlayParams((s) => s.direction);
  const maxHops = useOverlayParams((s) => s.maxHops);
  /** Counts the rebuilds that data arriving has asked for. */
  const [dataTick, setDataTick] = useState(0);

  const activeRef = useRef(active);
  activeRef.current = active;
  /** Counts structural changes, so the unit graph is rebuilt only when edges or units change. */
  const structureRev = useRef(0);
  const graph = useRef<{ replica: ModelReplica; at: number; adjacency: Adjacency } | null>(null);

  useEffect(() => {
    if (!replica) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = -Infinity;
    const rebuild = () => {
      timer = undefined;
      last = performance.now();
      setDataTick((t) => t + 1);
    };
    const unsubscribe = replica.subscribe((batch) => {
      const touched = batchTouches(batch);
      if (touched.structure) structureRev.current++;
      const now = activeRef.current;
      if (!now || !touchesOverlay(touched, now) || timer !== undefined) return;
      // the first chunk shows at once; the ones behind it wait their turn
      const wait = OVERLAY_UI.recomputeMs - (performance.now() - last);
      if (wait <= 0) rebuild(); else timer = setTimeout(rebuild, wait);
    });
    return () => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [replica]);

  const reach = active?.id === 'reach';
  const seedsFrom = reach ? selection : NO_SELECTION;
  const seeds = useMemo(
    () => (reach && replica ? seedSlots(seedsFrom, replica) : NO_SEEDS),
    // dataTick stands for the replica's contents, which change in place
    [reach, replica, seedsFrom, dataTick],
  );

  const view = useMemo(() => {
    if (!active || !replica) return null;
    const ctx: OverlayContext = { replica, mode };
    if (active.id === 'ownership') ctx.contributorId = contributorId;
    if (active.id === 'reach') {
      let g = graph.current;
      if (!g || g.replica !== replica || g.at !== structureRev.current) {
        g = graph.current = { replica, at: structureRev.current, adjacency: buildAdjacency(replica) };
      }
      ctx.adjacency = g.adjacency;
      ctx.seeds = seeds;
      ctx.direction = direction;
      ctx.maxHops = maxHops;
    }
    return overlayView(active.id, ctx);
    // dataTick stands for the replica's contents, which change in place
  }, [active, replica, mode, contributorId, direction, maxHops, seeds, dataTick]);

  useEffect(() => {
    if (!render) return;
    // the renderer may still be another package's stub; a failure there must not take the pills down
    try { render.setOverlay(view); } catch (err) { console.warn('starmap: setOverlay failed', err); }
  }, [render, view]);

  // the hover tooltip reads the view to tell a file's age or hops
  useEffect(() => {
    useOverlayParams.setState({ shown: view });
    return () => useOverlayParams.setState({ shown: null });
  }, [view]);

  return { view, seeds };
}
