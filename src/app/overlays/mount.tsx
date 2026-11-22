// Top right, before the settings gear: one pill per overlay, and under them a card with the active
// overlay's legend and parameters (PLAN.md §3.1, §10, §17.6). One overlay is active at a time; a pill
// can be chosen while its data is still arriving, and shows how far that has got.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AppMount } from '../../contracts/app';
import {
  OVERLAYS, legendFor, ownershipContributors,
  type OverlayId, type OverlayInfo, type OverlayLegend, type ReachDirection,
} from '../../overlays';
import { setActiveOverlay, useApp, useReplicaVersion, useSession } from '../store';
import { Card, PillButton, Segmented, Strong, cx, type SegmentedOption } from '../ui';
import { ContributorPicker } from './ContributorPicker';
import { historyUnavailable, pillState, type PillState } from './logic';
import { setContributor, setDirection, useOverlayParams } from './state';
import { useOverlayView } from './useOverlayView';
import './overlays.css';

/** What each overlay shows, for the pill's tooltip. */
const ABOUT: Record<OverlayId, string> = {
  recency: 'How recently each file changed',
  ownership: 'One contributor’s share of the commits to each file',
  reach: 'What the selected files depend on, or what depends on them',
  knowledgeRisk: 'Files where one person made most of the commits',
  tests: 'Test files, and the files they do and do not reference',
};

/** Shorter names for the pills when the row is tight (overlays.css decides when). */
const SHORT: Partial<Record<OverlayId, string>> = { reach: 'Reach', knowledgeRisk: 'Risk' };

const DIRECTIONS: SegmentedOption<ReachDirection>[] = [
  { value: 'dependsOn', label: 'Depends on' },
  { value: 'dependedOnBy', label: 'Depended on by' },
];

const percent = (coverage: number): string => `${Math.floor(Math.min(1, Math.max(0, coverage)) * 100)}%`;

function stateText(state: PillState): string {
  return state.kind === 'partial' ? `filling in, ${percent(state.coverage)}` : state.kind === 'pending' ? 'no data yet' : '';
}

// ---- pills ----

const RING = { size: 14, r: 5.5 };
const RING_LENGTH = 2 * Math.PI * RING.r;

/** The pill's dot: hollow while there is no data, inside a progress ring while data is arriving. */
function StateMark({ state }: { state: PillState }) {
  const c = RING.size / 2;
  return (
    <svg className="gm-overlay-mark" width={RING.size} height={RING.size} viewBox={`0 0 ${RING.size} ${RING.size}`} aria-hidden="true" focusable="false">
      {state.kind === 'partial' && (
        <>
          <circle className="gm-overlay-ring-track" cx={c} cy={c} r={RING.r} />
          <circle
            className="gm-overlay-ring" cx={c} cy={c} r={RING.r} transform={`rotate(-90 ${c} ${c})`}
            strokeDasharray={RING_LENGTH} strokeDashoffset={RING_LENGTH * (1 - state.coverage)}
          />
        </>
      )}
      <circle className="gm-overlay-dot" cx={c} cy={c} r={state.kind === 'pending' ? 2.4 : 2.5} />
    </svg>
  );
}

interface ShownOverlay { info: OverlayInfo; state: PillState }

function OverlayPills({ shown, activeId }: { shown: ShownOverlay[]; activeId: string | null }) {
  const bar = useRef<HTMLDivElement>(null);
  // one tab stop for the row: the active overlay's pill, or the one last focused
  const [focused, setFocused] = useState<string | null>(null);
  const ids = shown.map((s) => s.info.id as string);
  const stop = activeId !== null && ids.includes(activeId) ? activeId : focused !== null && ids.includes(focused) ? focused : ids[0];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(bar.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    const last = buttons.length - 1;
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (at === last ? 0 : at + 1)
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (at === 0 ? last : at - 1)
      : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <div className="gm-overlays" role="toolbar" aria-label="Overlays" ref={bar} onKeyDown={onKeyDown}>
      {shown.map(({ info, state }) => {
        const on = info.id === activeId;
        const note = stateText(state);
        const short = SHORT[info.id];
        return (
          <PillButton
            key={info.id}
            blur
            active={on}
            className={cx('gm-overlay-pill', `is-${state.kind}`)}
            aria-pressed={on}
            aria-label={note ? `${info.label}, ${note}` : info.label}
            title={on ? `Turn ${info.label} off` : note ? `${ABOUT[info.id]} (${note})` : ABOUT[info.id]}
            tabIndex={info.id === stop ? 0 : -1}
            onFocus={() => setFocused(info.id)}
            onClick={() => setActiveOverlay(on ? null : info.id)}
          >
            <StateMark state={state} />
            <span className={cx('gm-overlay-label', short !== undefined && 'has-short')}>{on ? <Strong>{info.label}</Strong> : info.label}</span>
            {short !== undefined && <span className="gm-overlay-label is-short">{on ? <Strong>{short}</Strong> : short}</span>}
          </PillButton>
        );
      })}
    </div>
  );
}

// ---- the card ----

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <li className="gm-ov-swatch-row">
      <span className="gm-ov-swatch" style={{ background: color }} aria-hidden="true" />
      <span>{label}</span>
    </li>
  );
}

/** The ramp with its end labels, or the category swatches; then "not yet known" and how far the data has got. */
function LegendRows({ legend }: { legend: OverlayLegend }) {
  const gradient = `linear-gradient(to right, ${legend.stops.map((s) => `${s.color} ${(s.t * 100).toFixed(1)}%`).join(', ')})`;
  return (
    <div className="gm-ov-legend" role="group" aria-label={`${legend.label} legend`}>
      {!legend.discrete && (
        <div className="gm-ov-ramp" role="img" aria-label={`From ${legend.low} to ${legend.high}`}>
          <div className="gm-ov-ramp-bar" style={{ background: gradient }} />
          <div className="gm-ov-ramp-ends" aria-hidden="true">
            <span title={legend.low}>{legend.low}</span>
            <span title={legend.high}>{legend.high}</span>
          </div>
        </div>
      )}
      <ul className="gm-ov-swatches">
        {legend.categories.map((c) => <Swatch key={c.label} color={c.color} label={c.label} />)}
        <Swatch color={legend.unknown.color} label={legend.unknown.label} />
      </ul>
      {legend.status === 'partial' && <p className="gm-ov-line" role="status">Filling in · {percent(legend.coverage ?? 0)}</p>}
      {legend.status === 'pending' && <p className="gm-ov-line" role="status">Waiting for data</p>}
    </div>
  );
}

function Overlays() {
  const session = useSession();
  useReplicaVersion(); // the pills follow each layer's status and coverage as batches land
  const activeId = useApp((s) => s.activeOverlay);
  const noticed = useOverlayParams((s) => s.noHistory);
  const contributorId = useOverlayParams((s) => s.contributorId);
  const direction = useOverlayParams((s) => s.direction);

  const replica = session?.replica ?? null;
  const hasFolder = session?.source.kind === 'directory' || (session?.source.kind === 'snapshot' && session.source.locator !== undefined);
  const noHistory = historyUnavailable(noticed, replica?.meta?.source, hasFolder);
  const shown: ShownOverlay[] = [];
  if (replica) {
    for (const info of OVERLAYS) {
      const state = pillState(info, info.layer === null ? null : replica.layers.get(info.layer), noHistory);
      if (state.kind !== 'hidden') shown.push({ info, state });
    }
  }
  const active = shown.find((s) => s.info.id === activeId)?.info ?? null;

  // Ownership: the viewer's choice while that person is still on the list, else the top contributor
  const contributors = active?.id === 'ownership' ? ownershipContributors(replica?.layers.get('ownership')) : [];
  const chosen = contributors.find((c) => c.id === contributorId) ?? contributors[0] ?? null;
  const { view, seeds } = useOverlayView(active, chosen?.id);

  // an overlay that is not on offer (hidden, or switched off in config) cannot stay selected
  const stale = replica !== null && activeId !== null && active === null;
  useEffect(() => { if (stale) setActiveOverlay(null); }, [stale]);

  if (shown.length === 0) return null;
  return (
    <>
      <OverlayPills shown={shown} activeId={active?.id ?? null} />
      {active && view && (
        <div className="gm-overlay-card-row">
          <Card blur className="gm-overlay-card" role="group" aria-label={`${active.label} overlay`}>
            <div className="gm-ov-title"><Strong>{active.label}</Strong></div>
            {active.id === 'ownership' && <ContributorPicker contributors={contributors} chosen={chosen} onChoose={setContributor} />}
            {active.id === 'reach' && <Segmented label="Direction" value={direction} options={DIRECTIONS} onChange={setDirection} className="gm-ov-direction" />}
            {/* with nothing selected there is no reach to explain, only how to get one */}
            {active.id === 'reach' && seeds.length === 0
              ? <p className="gm-ov-line gm-ov-hint" role="status">Select a file to see its reach</p>
              : <LegendRows legend={legendFor(view)} />}
          </Card>
        </div>
      )}
    </>
  );
}

// Before the settings gear (1000), which stays at the end of the row.
const mount: AppMount = { region: 'topRight', order: 100, Component: Overlays };
export default mount;
