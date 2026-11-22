// In the scene: the tooltip for the hovered file and the detail card for the focused selection
// (PLAN.md §9, §17.6). Both are translucent cards anchored to their sphere and following it.
import { useCallback, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { config } from '../../config';
import type { AppMount } from '../../contracts/app';
import type { RenderApi, ScreenPoint } from '../../contracts/render';
import type { NodeRef } from '../../model/types';
import { overlayFact } from '../../overlays';
import { useOverlayParams } from '../overlays/state';
import { languageColor, unitRadius } from '../../shared';
import { clamp, groundToPixels, useAnchor, type Place, type Placement } from '../anchor';
import { LAYER, useDismissable } from '../keys';
import { selectOnly, setFocus, useApp, useFocus, useHover, useRender, useReplica, useReplicaVersion } from '../store';
import { APP_LOCAL } from '../tunables';
import { Card, CloseIcon, Strong } from '../ui';
import { countLabel, percentileLabel, unitDetails, unitSummary, type Neighbor, type UnitSummary } from '../units';
import './inspect.css';

/** A sphere's radius on screen, in CSS pixels. */
function spherePixels(render: RenderApi, at: ScreenPoint, unit: UnitSummary, selected: boolean): number {
  const radius = unitRadius(unit.loc, unit.importancePct, config.visual) * (selected ? config.visual.selectedScale : 1);
  return groundToPixels(render, at, radius, 'x');
}

function LanguageDot({ lang }: { lang: string }) {
  const meta = useReplica()?.meta ?? null;
  return <span className="gm-lang-dot" style={{ background: languageColor(lang, config.visual, meta?.languages?.[lang]?.color) }} aria-hidden="true" />;
}

// ---- tooltip ----

function Tooltip() {
  const replica = useReplica();
  const hover = useHover();
  const focus = useFocus();
  const overlay = useOverlayParams((s) => s.shown);
  const selected = useApp((s) => hover !== null && s.selection.includes(hover));
  const box = useRef<HTMLDivElement>(null);
  // the focused file already has its card open beside it
  const target = hover !== null && hover !== focus ? hover : null;
  const unit = replica && target ? unitSummary(replica, target) : null;

  const place = useCallback<Place>((at, size, view, render) => {
    if (!unit) return null;
    const { tooltipGapPx: gap, marginPx: margin } = APP_LOCAL.anchor;
    const r = spherePixels(render, at, unit, selected);
    const above = at.y - r - gap - size.height;
    return {
      x: clamp(at.x - size.width / 2, margin, view.width - size.width - margin),
      y: above >= margin ? above : at.y + r + gap,
    };
  }, [unit?.slot, unit?.loc, unit?.importancePct, selected]);
  // the active overlay's word on this file: its age under Recency, its hops under Dependency reach
  const fact = replica && unit && overlay ? overlayFact(overlay, replica, unit.slot) : null;
  useAnchor(unit ? target : null, box, place, unit ? `${unit.path}|${unit.loc}|${unit.fanIn}|${unit.fanOut}|${fact}` : null);

  if (!unit) return null;
  return (
    <Card className="gm-tooltip" role="tooltip" ref={box}>
      <div className="gm-tooltip-name"><Strong>{unit.name}</Strong></div>
      <div className="gm-tooltip-path">{unit.path}</div>
      <div className="gm-tooltip-facts">
        <span className="gm-fact"><LanguageDot lang={unit.lang} />{unit.langName}</span>
        <span className="gm-fact">{countLabel(unit.loc, 'line', 'lines')}</span>
        <span className="gm-fact" title="Files that depend on it, and files it depends on">
          {unit.fanIn.toLocaleString()} in · {unit.fanOut.toLocaleString()} out
        </span>
      </div>
      {fact && <div className="gm-tooltip-overlay">{fact}</div>}
    </Card>
  );
}

// ---- detail card ----

function Neighbors({ label, count, list, onOpen }: { label: string; count: number; list: Neighbor[]; onOpen: () => void }) {
  const render = useRender();
  const open = (ref: NodeRef) => {
    onOpen();
    selectOnly(ref);
    void render?.flyTo(ref).catch(() => {});
  };
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <Strong>{count.toLocaleString()}</Strong>
        {list.length > 0 && (
          <span className="gm-detail-names">
            {list.map((n) => (
              <button key={n.ref} type="button" className="gm-detail-link" title={n.path} onClick={() => open(n.ref)}>{n.name}</button>
            ))}
            {count > list.length && <span className="gm-dim">+{(count - list.length).toLocaleString()} more</span>}
          </span>
        )}
      </dd>
    </>
  );
}

function DetailCard() {
  const replica = useReplica();
  const rev = useReplicaVersion();
  const focus = useFocus();
  const box = useRef<HTMLDivElement>(null);
  /** Where the user dragged the card to, in scene pixels: it then stays there instead of beside its sphere. */
  const pinned = useRef<Placement | null>(null);
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null);
  // a newly focused file opens its card beside its sphere again
  useEffect(() => { pinned.current = null; }, [focus]);

  // Following a name in the card replaces the button that was pressed: the keyboard focus stays in the card.
  const keepFocus = useRef(false);
  useEffect(() => {
    if (keepFocus.current) box.current?.focus({ preventScroll: true });
    keepFocus.current = false;
  }, [focus]);

  // Closing keeps the file selected. If the keyboard focus was in the card it goes to the file's
  // selection pill, which is how to open the card again.
  const close = () => {
    const inside = focus !== null && (box.current?.contains(document.activeElement) ?? false);
    setFocus(null);
    if (inside) document.querySelector<HTMLElement>(`.gm-selected-name[data-ref="${CSS.escape(focus)}"]`)?.focus();
  };
  // Escape closes the card first; the next press clears the selection (keys.ts)
  useDismissable(focus !== null, close, { layer: LAYER.card });
  // the edge scan runs once per focused file and model revision, never per frame
  const unit = useMemo(
    () => (replica && focus ? unitDetails(replica, focus, APP_LOCAL.detail.namesShown) : null),
    [replica, focus, rev],
  );

  const place = useCallback<Place>((at, size, view, render) => {
    if (!unit) return null;
    const { cardGapPx: gap, marginPx: margin } = APP_LOCAL.anchor;
    const p = pinned.current;
    if (p) return { x: clamp(p.x, margin, view.width - size.width - margin), y: clamp(p.y, margin, view.height - size.height - margin) };
    const r = spherePixels(render, at, unit, true);
    const right = at.x + r + gap;
    return {
      // to the right of the sphere, or to its left when there is no room
      x: right + size.width <= view.width - margin ? right : Math.max(margin, at.x - r - gap - size.width),
      y: clamp(at.y - size.height / 2, margin, view.height - size.height - margin),
    };
  }, [unit]);
  useAnchor(unit ? focus : null, box, place, unit, true);

  // ---- dragging by the top bar: the card stays where it is dropped until another file is focused ----
  /** The card's top left in its scene's coordinates. */
  const cardAt = (el: HTMLElement): Placement => {
    const r = el.getBoundingClientRect(), parent = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    return { x: r.left - (parent?.left ?? 0), y: r.top - (parent?.top ?? 0) };
  };
  const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = box.current;
    if (!el || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const at = cardAt(el);
    drag.current = { id: e.pointerId, dx: e.clientX - at.x, dy: e.clientY - at.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = box.current, d = drag.current;
    if (!el || !d || d.id !== e.pointerId) return;
    const view = el.offsetParent as HTMLElement | null;
    const { marginPx: margin } = APP_LOCAL.anchor;
    const x = clamp(e.clientX - d.dx, margin, (view?.clientWidth ?? Infinity) - el.offsetWidth - margin);
    const y = clamp(e.clientY - d.dy, margin, (view?.clientHeight ?? Infinity) - el.offsetHeight - margin);
    pinned.current = { x, y };
    // written here as well: the scene may not render a frame while nothing in it moves
    el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  };
  const onDragEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
  };

  if (!unit) return null;
  const pair = unit.files.length > 1;
  return (
    <Card className="gm-detail" role="region" aria-label={`Details of ${unit.name}`} tabIndex={-1} ref={box}>
      <div
        className="gm-detail-head"
        title="Drag to move"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <div className="gm-detail-title">
          {pair
            ? unit.files.map((path) => <Strong key={path}>{path.slice(path.lastIndexOf('/') + 1)}</Strong>)
            : <Strong>{unit.name}</Strong>}
        </div>
        <button type="button" className="gm-icon-button" aria-label="Close details" title="Close details (Esc)" onClick={close}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="gm-detail-path">{unit.path}</div>
      <dl className="gm-detail-facts">
        <dt>Language</dt>
        <dd><span className="gm-fact"><LanguageDot lang={unit.lang} />{unit.langName}</span></dd>
        <dt>Lines of code</dt>
        <dd>{unit.loc.toLocaleString()}{pair && <span className="gm-dim"> across {unit.files.length} files</span>}</dd>
        <dt>Importance</dt>
        <dd>{percentileLabel(unit.importancePct)}</dd>
        {(unit.city || unit.district) && (
          <>
            <dt>Located in</dt>
            <dd>{[unit.city, unit.district].filter(Boolean).join(' › ')}</dd>
          </>
        )}
        <Neighbors label="Dependents" count={unit.dependentCount} list={unit.dependents} onOpen={() => { keepFocus.current = box.current?.contains(document.activeElement) ?? false; }} />
        <Neighbors label="Dependencies" count={unit.dependencyCount} list={unit.dependencies} onOpen={() => { keepFocus.current = box.current?.contains(document.activeElement) ?? false; }} />
      </dl>
    </Card>
  );
}

// after the pills (order 0), so the cards lie over them
const mounts: AppMount[] = [
  { region: 'scene', order: 10, Component: DetailCard },
  { region: 'scene', order: 20, Component: Tooltip },
];
export default mounts;
