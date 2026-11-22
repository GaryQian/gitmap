// In the scene: what a city does, in the AI's words, on a card under its pill while the pointer
// rests there or the pill has keyboard focus, and pinned there once the pill is clicked (PLAN.md
// §11.1, §17.6). React renders the card's text when the target or the model changes; where the card sits is
// written straight onto it whenever its pill moves, never through React state.
import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { config } from '../../config';
import type { AppMount } from '../../contracts/app';
import type { ModelReplica } from '../../contracts/store';
import type { NodeRef } from '../../model/types';
import { sceneObstacles } from '../anchor';
import { LAYER, isTyping, topDismissable, useDismissable } from '../keys';
import { useApp, useRender, useReplica, useSession } from '../store';
import { APP_LOCAL } from '../tunables';
import { Card, cx } from '../ui';
import { cardContent, effectivePin, inFlight, pinAfter, placeCard, type CardContent, type Rect } from './logic';
import { watchPinGestures } from './pin';
import { trackPills, type PillTarget, type PillTracker } from './track';
import { SUMMARY_UI } from './tunables';
import './summaries.css';

/** The card's id: the pill it describes points here with `aria-describedby`. */
const CARD_ID = 'gm-summary-card';

/** The name on a city's or district's pill. */
function nodeName(replica: ModelReplica, ref: NodeRef): string {
  const kind = ref.startsWith('c:') ? 'city' : ref.startsWith('d:') ? 'district' : null;
  if (!kind) return '';
  const table = replica.table(kind);
  const slot = table.slotOf(ref.slice(2));
  return slot < 0 ? '' : (table.cols.name[slot] ?? '');
}

function contentOf(replica: ModelReplica | null | undefined, ref: NodeRef, generating: boolean): CardContent | null {
  return replica ? cardContent(replica.annotations, ref, nodeName(replica, ref), generating) : null;
}

/** Whether the node's card has anything in it right now, read straight from the store (for event handlers). */
function hasCardNow(ref: NodeRef): boolean {
  const { session, progress } = useApp.getState();
  return contentOf(session?.replica, ref, inFlight(progress.ai)) !== null;
}

/** Escape is free when nothing above the selection is about to close on it (keys.ts keeps the stack). */
function escapeIsFree(e: KeyboardEvent): boolean {
  if (isTyping(e.target)) return false;
  const top = topDismissable();
  return !top || (top.layer ?? LAYER.card) <= LAYER.selection;
}

/** The fixed chrome, in the coordinates of `view`: the card goes to the other side of its pill rather than under it. */
function readChrome(view: HTMLElement): { boxes: Rect[]; right: number } {
  const origin = view.getBoundingClientRect();
  const boxes: Rect[] = [];
  let right = view.clientWidth;
  const frame = view.closest('.gm-app')?.querySelector('.gm-frame');
  for (const el of frame?.querySelectorAll<HTMLElement>('.gm-pill, .gm-card, .gm-region-rightEdge > *') ?? []) {
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    // the open sidebar takes the whole right edge: the view ends where it begins
    const sidebar = el.parentElement?.classList.contains('gm-region-rightEdge') && r.height > view.clientHeight / 2;
    if (sidebar) right = Math.min(right, r.left - origin.left);
    else boxes.push({ x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height });
  }
  return { boxes, right };
}

function SummaryCard({ content, instant, pinned, ref }: { content: CardContent; instant: boolean; pinned: boolean; ref: Ref<HTMLDivElement> }) {
  // decided once, when the card appears: a card that is already up never fades in again
  const [still] = useState(instant);
  return (
    <Card id={CARD_ID} role="tooltip" className={cx('gm-summary', still && 'is-instant')} data-pinned={pinned || undefined} ref={ref}>
      {content.kind === 'pending' ? (
        <p className="gm-summary-wait">Summary on its way</p>
      ) : (
        <>
          {content.title && <div className="gm-summary-title">{content.title}</div>}
          <p className="gm-summary-text">{content.text}</p>
        </>
      )}
    </Card>
  );
}

function Summaries() {
  const render = useRender();
  const replica = useReplica();
  const generating = useApp((s) => inFlight(s.progress.ai));
  const session = useSession();
  /** The city whose pill was clicked: its card is pinned, whatever the pointer does next. */
  const [clicked, setClicked] = useState<NodeRef | null>(null);
  const clickedNow = useRef(clicked);
  clickedNow.current = clicked;
  /** ... and failing that a selected city, should anything ever select one. */
  const pinned = useApp((s) => effectivePin(clicked, s.selection));
  const [target, setTarget] = useState<PillTarget | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const tracker = useRef<PillTracker | null>(null);
  const place = useRef<() => void>(() => {});

  useEffect(() => {
    const tracking = trackPills(document, {
      delayMs: config.interaction.hoverDelayMs,
      graceMs: SUMMARY_UI.graceMs,
      hasCard: hasCardNow,
      onTarget: setTarget,
      onMove: () => place.current(),
    });
    tracker.current = tracking;
    return () => { tracker.current = null; tracking.dispose(); };
  }, []);

  // A click on a city pill pins its card, on the pinned pill again unpins it; a click on the open
  // map or a free Escape lets go. Only listened to: the click still flies the camera to the city.
  useEffect(() => watchPinGestures(document, {
    clickSlopPx: APP_LOCAL.pills.clickSlopPx,
    escapeIsFree,
    onGesture: (gesture) => {
      const before = clickedNow.current;
      const after = pinAfter(before, gesture.type === 'pill' ? { ...gesture, hasCard: hasCardNow(gesture.ref) } : gesture);
      if (after === before) return;
      clickedNow.current = after;
      setClicked(after);
      // the tracker hears at once, so the card never shows a state in between
      tracker.current?.setPinned(effectivePin(after, useApp.getState().selection));
      // unpinned by a click on its own pill, or by Escape with the pointer still on it: the card
      // goes now, not when the pointer leaves
      if (after === null && gesture.type !== 'ground') tracker.current?.dismiss(gesture.type === 'pill' ? gesture.ref : before ?? undefined);
    },
  }), []);

  // the pin does not outlive its map, or its city
  useEffect(() => setClicked(null), [session]);
  const gone = clicked !== null && replica !== null && replica.table('city').slotOf(clicked.slice(2)) < 0;
  useEffect(() => { if (gone) setClicked(null); }, [gone]);

  useEffect(() => tracker.current?.setPinned(pinned), [pinned]);

  // The tracker looks at its pills on every rendered frame while there is something to follow or to
  // find again (a pinned city's pill comes and goes with the camera), and whenever a summary arriving
  // or generation starting changes which pill has a card.
  const following = target !== null || pinned !== null;
  useEffect(() => {
    if (!render || !following) return;
    return render.on('frame', () => tracker.current?.check());
  }, [render, following]);
  const rev = replica?.rev ?? 0;
  useEffect(() => tracker.current?.check(), [rev, generating]);

  const pill = target?.el ?? null;
  const content = target ? contentOf(replica, target.ref, generating) : null;
  const showing = content !== null;

  // A hover or focus card is one layer of the app's Escape stack: a press closes it and nothing
  // else. A pinned card is not on the stack; Escape lets it go together with the selection (pin.ts).
  useDismissable(showing && target !== null && !target.pinned, () => tracker.current?.dismiss(), { layer: LAYER.card });

  // The card follows its pill: placed now and on every move of the pill (the tracker calls `place`).
  useLayoutEffect(() => {
    const box = card.current, view = host.current;
    if (!pill || !box || !view) return;
    let size = { width: box.offsetWidth, height: box.offsetHeight };
    let chrome = readChrome(view);
    let written = '';
    const run = () => {
      const origin = view.getBoundingClientRect();
      const r = pill.getBoundingClientRect();
      const spot = placeCard(
        { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height },
        size,
        { width: chrome.right, height: view.clientHeight },
        { gap: SUMMARY_UI.gapPx, margin: SUMMARY_UI.marginPx },
        sceneObstacles.size ? [...chrome.boxes, ...sceneObstacles] : chrome.boxes,
      );
      const transform = `translate3d(${Math.round(spot.x)}px, ${Math.round(spot.y)}px, 0)`;
      if (transform !== written) box.style.transform = written = transform;
      if (!box.hasAttribute('data-placed')) box.setAttribute('data-placed', '');
    };
    place.current = run;
    run();
    // the text changing, fonts arriving or the window resizing all change what fits where
    const resize = new ResizeObserver(() => {
      size = { width: box.offsetWidth, height: box.offsetHeight };
      chrome = readChrome(view);
      run();
    });
    resize.observe(box);
    resize.observe(view);
    return () => { resize.disconnect(); place.current = () => {}; };
  }, [pill, showing]);

  // While the card is up, pinned or not, it describes its pill, for screen readers too.
  useLayoutEffect(() => {
    if (!pill || !showing) return;
    pill.setAttribute('aria-describedby', CARD_ID);
    return () => { if (pill.getAttribute('aria-describedby') === CARD_ID) pill.removeAttribute('aria-describedby'); };
  }, [pill, showing]);

  return (
    <div className="gm-summary-layer" ref={host}>
      {target && content && <SummaryCard content={content} instant={target.instant} pinned={target.pinned} ref={card} />}
    </div>
  );
}

// after the pills (order 0) and the other in-scene cards (10, 20), so the summary lies over them
const mount: AppMount = { region: 'scene', order: 30, Component: Summaries };
export default mount;
