// Bottom centre: the "Tour the repo" pill, and the step card that takes its place while a tour plays
// (PLAN.md §9, §17.6). The tour is the replica's `tour` annotation; sequencing is in sequence.ts.
// Each step stands on a file. The camera flies to what the step frames (the file, or the district or
// city it belongs to just then) and the file and its highlights light up; selection, overlay and
// filters are left alone, and so is a camera the user moves mid-step.
import { useEffect, useId, useLayoutEffect, useRef, type RefObject } from 'react';
import type { AppMount } from '../../contracts/app';
import type { FlyOpts, FrameInfo, RenderApi } from '../../contracts/render';
import type { NodeRef, Tour, TourStep } from '../../model/types';
import { useApp, useRender, useReplicaVersion, useSession } from '../store';
import { Card, CloseIcon, PillButton, Strong, cx } from '../ui';
import { clearDistance, territoryRadius, type Box } from './framing';
import { currentStep, frameTarget, offeredTour } from './sequence';
import { goToStep, nextStep, offerTour, prevStep, startTour, stepForward, stopTour, useTour } from './state';
import './tour.css';

/** A renderer method may still be a stub, or the renderer disposed: the tour must survive either. */
function attempt(fn: () => void): void {
  try { fn(); } catch (err) { console.warn('gitmap: tour could not reach the renderer', err); }
}

/** Keep the tour on offer in step with the replica: it appears the moment its annotation arrives. */
function useOfferedTour(): void {
  const replica = useSession()?.replica ?? null;
  const rev = useReplicaVersion();
  useEffect(() => { offerTour(replica ? offeredTour(replica) : null); }, [replica, rev]);
  // leaving the map ends the tour
  useEffect(() => () => offerTour(null), []);
}

/** The element's box relative to the map canvas, which fills the window (the shell's `.gm-map-canvas`). */
function canvasBoxes(card: HTMLElement | null): { view: Box; card: Box | null } {
  const canvas = document.querySelector('canvas.gm-map-canvas')?.getBoundingClientRect();
  const x = canvas?.left ?? 0, y = canvas?.top ?? 0;
  const view: Box = { left: 0, top: 0, right: canvas?.width ?? window.innerWidth, bottom: canvas?.height ?? window.innerHeight };
  const c = card?.getBoundingClientRect();
  return { view, card: c ? { left: c.left - x, top: c.top - y, right: c.right - x, bottom: c.bottom - y } : null };
}

/**
 * Fly to what a step frames. A file is framed the renderer's way. A district or a city is framed from
 * far enough back that its territory clears the step card; when that cannot be worked out, the
 * renderer's own fit is used.
 */
function flyToStep(render: RenderApi, step: TourStep, camera: FrameInfo | null, card: HTMLElement | null): void {
  const { session, reducedMotion } = useApp.getState();
  if (!session) return;
  const target = frameTarget(step, session.replica);
  if (!target) return;
  const opts: FlyOpts = {};
  if (reducedMotion) opts.ms = 0;
  if (target !== step.parent && camera) {
    const radius = territoryRadius(target, session.replica, session.physics.positions);
    const boxes = canvasBoxes(card);
    const distance = radius === null ? null : clearDistance(render, camera, radius, boxes.view, boxes.card);
    if (distance !== null) opts.distance = distance;
  }
  // The renderer drops a flight in progress when a new one starts, so quick presses never queue:
  // the latest step wins. Nothing waits on the flight either, so a drag mid-step is not undone.
  void render.flyTo(target, opts).catch(() => {});
}

/** Camera and highlights follow the step on screen. */
function useChoreography(render: RenderApi | null, card: RefObject<HTMLDivElement | null>): void {
  const flight = useTour((s) => s.flight);
  const step = useTour((s) => currentStep(s.seq));
  const offered = useTour((s) => s.seq.tour !== null);
  const lit = step ? JSON.stringify([...new Set<NodeRef>([step.parent, ...step.highlights])]) : null;

  // Where the camera is, for framing districts and cities. Followed from the moment a tour is on
  // offer, so the first step already has it.
  const camera = useRef<FrameInfo | null>(null);
  useEffect(() => {
    camera.current = null;
    if (!render || !offered) return;
    return render.on('frame', (frame) => { camera.current = frame; });
  }, [render, offered]);

  useEffect(() => {
    const shown = currentStep(useTour.getState().seq);
    if (!render || !shown) return;
    attempt(() => flyToStep(render, shown, camera.current, card.current));
  }, [render, flight, card]);

  useEffect(() => {
    if (!render || lit === null) return;
    attempt(() => render.setHighlights(JSON.parse(lit) as NodeRef[]));
    // on the next step, on stop and on leaving the map; the camera stays where it is
    return () => attempt(() => render.setHighlights([]));
  }, [render, lit]);
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}
/** Controls that use the arrow keys themselves (the Appearance row in Settings, a slider). */
function usesArrows(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return typeof el?.closest === 'function' && el.closest('[role="radiogroup"], [role="slider"], [role="listbox"], [role="menu"], [role="tablist"]') !== null;
}
/** Controls that Space presses. */
function usesSpace(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return typeof el?.closest === 'function' && el.closest('button, a[href], summary, [role="button"], [role="checkbox"], [role="radio"], [role="option"]') !== null;
}

/**
 * While a tour plays: ← and → step, Space steps forward, Escape ends it. They work wherever the
 * focus is, except in a field the user is typing in or a control that uses the same key.
 * Space acts on release, and not at all if the pointer went down meanwhile: Space+drag orbits the map.
 */
function useTourKeys(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let spaceHeld = false;
    let spaceUsed = false;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      if (e.key === 'Escape') { e.preventDefault(); stopTour(); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (usesArrows(e.target)) return;
        e.preventDefault();
        if (e.key === 'ArrowRight') stepForward(); else prevStep();
        return;
      }
      if (e.key === ' ' && !usesSpace(e.target)) {
        e.preventDefault();
        if (!e.repeat) { spaceHeld = true; spaceUsed = false; }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== ' ' || !spaceHeld) return;
      spaceHeld = false;
      if (!spaceUsed) stepForward();
    };
    const onPointerDown = () => { if (spaceHeld) spaceUsed = true; };
    const onBlur = () => { spaceHeld = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    // capture: the map canvas takes pointer events for itself
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [active]);
}

function StepCard({ tour, index, cardRef }: { tour: Tour; index: number; cardRef: RefObject<HTMLDivElement | null> }) {
  const textId = useId();
  const total = tour.steps.length;
  const step = tour.steps[index]!;
  const last = index === total - 1;
  return (
    <Card blur ref={cardRef} className="gm-tour-card" role="region" aria-label="Tour of the repo" aria-describedby={textId} tabIndex={-1}>
      <div className="gm-tour-head">
        <span className="gm-tour-count">
          <span className="gm-tour-spark" aria-hidden="true" />
          <Strong>{index + 1} of {total}</Strong>
        </span>
        <button type="button" className="gm-tour-close" aria-label="End tour" title="End tour" onClick={stopTour}>
          <CloseIcon size={14} />
        </button>
      </div>
      <p className="gm-tour-text" id={textId} aria-live="polite">
        {/* keyed, so each step's text fades in; the live region itself stays in place */}
        <span key={index}>{step.text}</span>
      </p>
      <div className="gm-tour-foot">
        <div className="gm-tour-dots" role="group" aria-label="Steps">
          {tour.steps.map((_, i) => (
            <button
              key={i}
              type="button"
              className={cx('gm-tour-dot', i === index && 'is-current')}
              aria-label={`Step ${i + 1} of ${total}`}
              aria-current={i === index ? 'step' : undefined}
              onClick={() => goToStep(i)}
            />
          ))}
        </div>
        <div className="gm-tour-nav">
          <PillButton size="small" disabled={index === 0} onClick={prevStep}>Previous</PillButton>
          <PillButton size="small" className="gm-tour-next" onClick={nextStep}>{last ? 'Finish' : 'Next'}</PillButton>
        </div>
      </div>
    </Card>
  );
}

function TourControl() {
  useOfferedTour();
  const render = useRender();
  const card = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  useChoreography(render, card);
  const { tour, index, active } = useTour((s) => s.seq);
  useTourKeys(active);

  // Focus goes to the card when the tour starts and back to the pill when it ends, unless the user
  // has put it somewhere else in the meantime.
  const wasActive = useRef(false);
  useLayoutEffect(() => {
    if (active) card.current?.focus({ preventScroll: true });
    else if (wasActive.current && (!document.activeElement || document.activeElement === document.body)) pill.current?.focus({ preventScroll: true });
    wasActive.current = active;
  }, [active]);

  // No tour, nothing on screen: there is no disabled state.
  if (!tour) return null;
  if (active) return <StepCard tour={tour} index={index} cardRef={card} />;
  return (
    <PillButton blur ref={pill} className="gm-tour-pill" onClick={startTour}>
      <span className="gm-tour-spark" aria-hidden="true" />
      Tour the repo
    </PillButton>
  );
}

const mount: AppMount = { region: 'bottomCenter', order: 10, Component: TourControl };
export default mount;
