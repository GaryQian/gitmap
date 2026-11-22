// The shell: one background, the map canvas, the current screen, and the chrome regions above them.
import { useEffect, useRef, useState } from 'react';
import { config } from '../config';
import { Background } from './Background';
import { Landing } from './landing/Landing';
import { Region } from './mounts';
import { usePhone } from './phone';
import { attachCanvas } from './session';
import { setContextLost, useApp, usePhase, useReducedMotion, useRepoName, useSession } from './store';
import { CloseIcon, PillButton } from './ui';
import { Waiting } from './waiting/Waiting';

/** How long the map canvas takes to fade in over the background at the reveal; matches shell.css. */
const REVEAL_FADE_MS = 600;

/** The full-bleed canvas the session renders into. A new session gets a new element. */
function MapCanvas() {
  const session = useSession();
  const sessionId = useApp((s) => s.sessionId);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!session || !el) return;
    // The canvas itself says when its WebGL context goes and comes back; the renderer stops and
    // starts drawing on the same two events. Listening first means a context that is already gone
    // when the renderer is created is not missed.
    // (disposing a renderer also loses its context: that one belongs to a map already closed)
    const lost = () => { if (useApp.getState().session === session) setContextLost(true); };
    const restored = () => setContextLost(false);
    el.addEventListener('webglcontextlost', lost);
    el.addEventListener('webglcontextrestored', restored);
    attachCanvas(el);
    return () => {
      el.removeEventListener('webglcontextlost', lost);
      el.removeEventListener('webglcontextrestored', restored);
      setContextLost(false);
    };
  }, [session]);
  if (!session) return null;
  // named by the map's heading (title/mount.tsx); the label is the fallback while there is none
  return (
    <canvas
      key={sessionId}
      ref={canvas}
      className="gm-map-canvas"
      role="img"
      aria-labelledby="gm-map-heading"
      aria-label="Map of the repository"
    />
  );
}

export function App() {
  const phase = usePhase();
  const reducedMotion = useReducedMotion();
  const repoName = useRepoName();

  // The wisp canvas runs behind the landing page and the waiting screen, and until the map canvas
  // has faded in over it. After that the map draws the background itself.
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    if (phase !== 'map') { setCovered(false); return; }
    const timer = setTimeout(() => setCovered(true), reducedMotion ? 0 : REVEAL_FADE_MS + 100);
    return () => clearTimeout(timer);
  }, [phase, reducedMotion]);

  // a demo says so in the tab as well (plan/DEMO-MODE.md §5)
  const isDemo = useApp((s) => s.session?.source.kind === 'demo');
  useEffect(() => {
    document.title = phase === 'map' && repoName ? `${repoName}${isDemo ? ' (demo)' : ''} · ${config.app.title}` : config.app.title;
  }, [phase, repoName, isDemo]);

  useEffect(() => {
    // a file dropped anywhere must never navigate the page away from the map
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  // On a phone the chrome is folded away: only what is in use stays on the map, and the menu button
  // brings the rest back (shell.css). Each map starts folded.
  const phone = usePhone();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { if (phase !== 'map') setMenuOpen(false); }, [phase]);

  return (
    <div className="gm-app" data-phase={phase} data-phone={phone ? '' : undefined} data-menu={phone ? (menuOpen ? 'open' : 'closed') : undefined}>
      <Background live={!covered} />
      <MapCanvas />
      <Region name="scene" />
      {phase === 'landing' && <Landing />}
      {phase === 'waiting' && <Waiting />}
      <div className="gm-frame">
        <div className="gm-chrome">
          <div className="gm-chrome-row gm-chrome-top">
            <Region name="topLeft" />
            <Region name="topCenter" />
            <Region name="topRight" />
          </div>
          <div className="gm-chrome-row gm-chrome-bottom">
            <Region name="bottomLeft" />
            <Region name="bottomCenter" />
            <Region name="bottomRight" />
          </div>
        </div>
        <Region name="rightEdge" />
      </div>
      {phone && phase === 'map' && (
        <PillButton
          blur
          round
          size="small"
          className="gm-menu-button"
          active={menuOpen}
          aria-expanded={menuOpen}
          aria-label={menuOpen ? 'Close the menu' : 'Open the menu'}
          title={menuOpen ? 'Close the menu' : 'Open the menu'}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <CloseIcon size={14} /> : (
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true" focusable="false">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          )}
        </PillButton>
      )}
      <Region name="overlay" />
    </div>
  );
}
