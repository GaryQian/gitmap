// In the scene: city pills (name and file count, the larger, bolder tier) and smaller district
// pills, always shown where they do not overlap a city's (PLAN.md §8.4, §17.6). Drag one to move its city or district; click it to fly there.
// React only hosts the layer: every pill is a pooled element that layer.ts moves by hand.
import { useEffect, useRef } from 'react';
import type { AppMount } from '../../contracts/app';
import { useApp, useRender, useSession } from '../store';
import { createPillLayer, type PillLayer } from './layer';
import './pills.css';

function ScenePills() {
  const render = useRender();
  const session = useSession();
  const minLines = useApp((s) => s.minLines);
  const host = useRef<HTMLDivElement>(null);
  const layer = useRef<PillLayer | null>(null);

  useEffect(() => {
    if (!render || !session || !host.current) return;
    const made = createPillLayer(host.current, render, session);
    layer.current = made;
    return () => { layer.current = null; made.dispose(); };
  }, [render, session]);

  // the size slider changes the "visible / total" counts; by now the renderer has the new threshold
  useEffect(() => { layer.current?.invalidate(); }, [minLines]);

  return <div ref={host} className="gm-scene-pills" role="group" aria-label="Cities and districts" />;
}

const mount: AppMount = { region: 'scene', order: 0, Component: ScenePills };
export default mount;
