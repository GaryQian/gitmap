// In the scene: city pills (name and file count, the larger, bolder tier) and smaller district
// pills, always shown where they do not overlap a city's (PLAN.md §8.4, §17.6). Drag one to move its city or
// district; click it to select it and fly there (Shift+click adds it to the selection, or takes it out).
// React only hosts the layer: every pill is a pooled element that layer.ts moves by hand.
import { useEffect, useRef } from 'react';
import type { AppMount } from '../../contracts/app';
import type { NodeRef } from '../../model/types';
import { clearSelection, selectOnly, toggleSelection, useApp, useRender, useSelection, useSession } from '../store';
import { createPillLayer, type PillLayer } from './layer';
import './pills.css';

/** A click on a pill selects its city or district alone; on the one thing selected, it lets go. Shift adds or removes. */
function pick(ref: NodeRef, mods: { shift: boolean }): void {
  if (mods.shift) { toggleSelection(ref); return; }
  const { selection } = useApp.getState();
  if (selection.length === 1 && selection[0] === ref) clearSelection();
  else selectOnly(ref);
}

function ScenePills() {
  const render = useRender();
  const session = useSession();
  const minBytes = useApp((s) => s.minBytes);
  const districtTitles = useApp((s) => s.settings.districtTitles);
  const selection = useSelection();
  const host = useRef<HTMLDivElement>(null);
  const layer = useRef<PillLayer | null>(null);

  useEffect(() => {
    if (!render || !session || !host.current) return;
    const made = createPillLayer(host.current, render, session, { onPick: pick });
    made.setSelected(useApp.getState().selection);
    layer.current = made;
    return () => { layer.current = null; made.dispose(); };
  }, [render, session]);

  // the size slider changes the "visible / total" counts; by now the renderer has the new threshold
  useEffect(() => { layer.current?.invalidate(); }, [minBytes]);
  // district pills come and go with the legend's switch, even while the scene is still
  useEffect(() => { layer.current?.invalidate(); }, [districtTitles]);
  useEffect(() => { layer.current?.setSelected(selection); }, [selection]);

  return (
    <div
      ref={host}
      className="gm-scene-pills"
      role="group"
      aria-label="Cities and districts"
      aria-description="Arrow keys move between them. Enter selects one and flies to it. Shift with an arrow key moves it on the map."
    />
  );
}

const mount: AppMount = { region: 'scene', order: 0, Component: ScenePills };
export default mount;
