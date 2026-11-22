// The one background behind every screen (PLAN.md §17.1, §17.4): static dust drawn in CSS, and over
// it the wisp shader on a small canvas of its own whenever the renderer package can provide one.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { config } from '../config';
import type { BackgroundApi } from '../contracts/render';
import { createBackground } from '../render';
import { isNotImplemented } from './session';
import { useApp, useReducedMotion, useThemeMode } from './store';

function Wisps() {
  const mode = useThemeMode();
  const reducedMotion = useReducedMotion();
  const emphasis = useApp((s) => s.backgroundEmphasis);
  const canvas = useRef<HTMLCanvasElement>(null);
  const api = useRef<BackgroundApi | null>(null);
  const [drawing, setDrawing] = useState(false);

  useEffect(() => {
    const { mode: theme, backgroundEmphasis } = useApp.getState();
    let created: BackgroundApi;
    try {
      created = createBackground(canvas.current!, { config, theme, reducedMotion });
      created.setEmphasis(backgroundEmphasis);
    } catch (err) {
      // no shader yet, or no WebGL: the static dust underneath is the whole background
      if (!isNotImplemented(err)) console.warn('starmap: wisp background unavailable', err);
      return;
    }
    api.current = created;
    setDrawing(true);
    return () => {
      api.current = null;
      setDrawing(false);
      created.dispose();
    };
  }, [reducedMotion]);

  useEffect(() => { api.current?.setTheme(mode); }, [mode, drawing]);
  useEffect(() => { api.current?.setEmphasis(emphasis); }, [emphasis, drawing]);

  // keyed, so a renderer rebuilt for a motion-preference change starts on a canvas with no old context
  return <canvas key={String(reducedMotion)} ref={canvas} className="gm-bg-canvas" hidden={!drawing} aria-hidden="true" />;
}

/**
 * `live` runs the shader. The shell turns it off once the map's own canvas covers the page, so two
 * WebGL scenes never draw the same wisps at once.
 */
export function Background({ live }: { live: boolean }) {
  const emphasis = useApp((s) => s.backgroundEmphasis);
  return (
    <div className="gm-bg" style={{ '--gm-bg-emphasis': emphasis } as CSSProperties} aria-hidden="true">
      {live && <Wisps />}
    </div>
  );
}
