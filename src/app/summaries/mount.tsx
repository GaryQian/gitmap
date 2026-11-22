// In the scene: what a city does, in the AI's words, on a card under its pill while the pointer
// rests there or the pill has keyboard focus (PLAN.md §11.1, §17.6). React renders the card's text
// when the target or the model changes; where the card sits is written straight onto it whenever
// its pill moves, never through React state.
import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { config } from '../../config';
import type { AppMount } from '../../contracts/app';
import type { ModelReplica } from '../../contracts/store';
import type { NodeRef } from '../../model/types';
import { sceneObstacles } from '../anchor';
import { useApp, useRender, useReplica } from '../store';
import { Card, cx } from '../ui';
import { cardContent, inFlight, placeCard, type CardContent, type Rect } from './logic';
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
    // the sidebar takes the whole right edge: the view ends where it begins
    if (el.parentElement?.classList.contains('gm-region-rightEdge')) right = Math.min(right, r.left - origin.left);
    else boxes.push({ x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height });
  }
  return { boxes, right };
}

function SummaryCard({ content, instant, ref }: { content: CardContent; instant: boolean; ref: Ref<HTMLDivElement> }) {
  // decided once, when the card appears: a card that is already up never fades in again
  const [still] = useState(instant);
  return (
    <Card id={CARD_ID} role="tooltip" className={cx('gm-summary', still && 'is-instant')} ref={ref}>
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
  const [target, setTarget] = useState<PillTarget | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const tracker = useRef<PillTracker | null>(null);
  const place = useRef<() => void>(() => {});

  useEffect(() => {
    const tracking = trackPills(document, {
      delayMs: config.interaction.hoverDelayMs,
      graceMs: SUMMARY_UI.graceMs,
      hasCard: ({ ref }) => {
        const { session, progress } = useApp.getState();
        return contentOf(session?.replica, ref, inFlight(progress.ai)) !== null;
      },
      onTarget: setTarget,
      onMove: () => place.current(),
    });
    tracker.current = tracking;
    return () => { tracker.current = null; tracking.dispose(); };
  }, []);

  const pill = target?.el ?? null;
  const content = target ? contentOf(replica, target.ref, generating) : null;
  const showing = content !== null;

  // The card follows its pill: placed now, on every move of the pill, and on every rendered frame.
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
    // the tracker looks at the pill first (recycled, hidden, dragged?) and calls back to place the card
    const off = render?.on('frame', () => tracker.current?.check());
    // the text changing, fonts arriving or the window resizing all change what fits where
    const resize = new ResizeObserver(() => {
      size = { width: box.offsetWidth, height: box.offsetHeight };
      chrome = readChrome(view);
      run();
    });
    resize.observe(box);
    resize.observe(view);
    return () => { off?.(); resize.disconnect(); place.current = () => {}; };
  }, [pill, showing, render]);

  // While the card is up it describes its pill, for screen readers too.
  useLayoutEffect(() => {
    if (!pill || !showing) return;
    pill.setAttribute('aria-describedby', CARD_ID);
    return () => { if (pill.getAttribute('aria-describedby') === CARD_ID) pill.removeAttribute('aria-describedby'); };
  }, [pill, showing]);

  return (
    <div className="gm-summary-layer" ref={host}>
      {target && content && <SummaryCard content={content} instant={target.instant} ref={card} />}
    </div>
  );
}

// after the pills (order 0) and the other in-scene cards (10, 20), so the summary lies over them
const mount: AppMount = { region: 'scene', order: 30, Component: Summaries };
export default mount;
