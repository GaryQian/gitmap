// Bottom right: the file-type legend and the minimum-size slider in one translucent card
// (PLAN.md §9, §17.6). A row isolates its type (Shift+click for several); the slider hides small,
// unimportant files without moving anything.
import { useId, useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import { config } from '../../config';
import type { AppMount } from '../../contracts/app';
import { languageColor } from '../../shared';
import { setDistrictTitles, setMinBytes, setPoiBeams, setRibbons, setTypeFilter, useApp, useReplica, useReplicaVersion, type Settings } from '../store';
import { APP_LOCAL } from '../tunables';
import { Card, Strong, cx } from '../ui';
import { countLabel, formatBytes, languageName } from '../units';
import { countBelow, hideableSizes, languageCounts, minBytesValueText, nextTypeFilter, sizeToSlider, sliderToSize } from './slider';
import './legend.css';

const STEPS = APP_LOCAL.legend.sliderSteps;

function TypeRows() {
  const replica = useReplica();
  const rev = useReplicaVersion();
  const typeFilter = useApp((s) => s.typeFilter);
  const rows = useMemo(() => {
    if (!replica) return [];
    const units = replica.table('unit');
    // one sphere per unit, so the legend counts units: a header + implementation pair is one file here
    return languageCounts(units.cols.lang, (slot) => units.ids[slot] != null);
  }, [replica, rev]);
  if (!replica || rows.length === 0) return null;

  const filtering = typeFilter.length > 0;
  const onClick = (lang: string) => (e: MouseEvent) => setTypeFilter(nextTypeFilter(useApp.getState().typeFilter, lang, e.shiftKey));

  return (
    <ul className="gm-legend-rows" aria-label="File types. Enter or Space shows one type alone; with Shift held it adds a type or takes it out.">
      {rows.map(({ lang, count }) => {
        const on = typeFilter.includes(lang);
        const name = languageName(replica.meta, lang);
        return (
          <li key={lang}>
            <button
              type="button"
              className={cx('gm-legend-row', on && 'is-active', filtering && !on && 'is-dimmed')}
              aria-pressed={on}
              aria-label={`${name}, ${countLabel(count, 'file', 'files')}`}
              title={on ? 'Show all types again' : `Show only ${name} (Shift+click or Shift+Enter to add)`}
              onClick={onClick(lang)}
            >
              <span className="gm-lang-dot" style={{ background: languageColor(lang, config.visual, replica.meta?.languages?.[lang]?.color) }} aria-hidden="true" />
              <span className="gm-legend-name">{on ? <Strong>{name}</Strong> : name}</span>
              <span className="gm-legend-count">{count.toLocaleString()}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function MinBytes() {
  const replica = useReplica();
  const rev = useReplicaVersion();
  const minBytes = useApp((s) => s.minBytes);
  const id = useId();

  const { maxBytes, hideable, total } = useMemo(() => {
    if (!replica) return { maxBytes: 0, hideable: [] as number[], total: 0 };
    const units = replica.table('unit');
    const live = (slot: number) => units.ids[slot] != null;
    let max = 0;
    for (let i = 0; i < units.capacity; i++) if (live(i) && units.cols.bytes[i]! > max) max = units.cols.bytes[i]!;
    return { maxBytes: max, hideable: hideableSizes(units.cols.bytes, units.cols.importancePct, config.visual, live), total: units.count };
  }, [replica, rev]);

  // The thumb keeps its own position: several positions round to the same size at the low
  // end, and a thumb driven by the rounded value would jump under the pointer.
  const [step, setStep] = useState(() => Math.round(sizeToSlider(minBytes, maxBytes) * STEPS));
  const shownStep = sliderToSize(step / STEPS, maxBytes) === Math.min(minBytes, maxBytes)
    ? step
    : Math.round(sizeToSlider(minBytes, maxBytes) * STEPS); // the threshold or the model changed elsewhere

  const hidden = countBelow(hideable, minBytes);
  const summary = hidden === 0 ? 'Showing every file' : `Hiding ${hidden.toLocaleString()} of ${countLabel(total, 'file', 'files')}`;

  return (
    <div className="gm-minlines">
      <div className="gm-minlines-head">
        <label htmlFor={id}>Minimum file size</label>
        <Strong>{formatBytes(minBytes)}</Strong>
      </div>
      <input
        id={id}
        className="gm-slider"
        type="range"
        min={0}
        max={STEPS}
        step={1}
        value={shownStep}
        disabled={maxBytes === 0}
        style={{ '--gm-slider-fill': `${(shownStep / STEPS) * 100}%` } as CSSProperties}
        aria-valuetext={minBytesValueText(minBytes, hidden, total)}
        onChange={(e) => {
          const next = Number(e.target.value);
          setStep(next);
          setMinBytes(sliderToSize(next / STEPS, maxBytes));
        }}
      />
      {/* not a live region: the slider's value text already says this once per step */}
      <div className="gm-minlines-summary">{summary}</div>
    </div>
  );
}

/** What the map draws besides the stars: one toggle each, remembered in the browser like the other settings. */
const LAYERS: { key: keyof Pick<Settings, 'ribbons' | 'poiBeams' | 'districtTitles'>; label: string; full: string; set(on: boolean): void }[] = [
  { key: 'ribbons', label: 'Links', full: 'Connections', set: setRibbons },
  { key: 'poiBeams', label: 'POIs', full: 'POI beams', set: setPoiBeams },
  { key: 'districtTitles', label: 'Districts', full: 'District titles', set: setDistrictTitles },
];

function LayerToggles() {
  const settings = useApp((s) => s.settings);
  return (
    <div className="gm-legend-layers" role="group" aria-label="Show on the map">
      {LAYERS.map(({ key, label, full, set }) => {
        const on = settings[key];
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            aria-label={full}
            title={`${on ? 'Hide' : 'Show'} ${full.toLowerCase()}`}
            className={cx('gm-legend-chip', on && 'is-on')}
            onClick={() => set(!on)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function Legend() {
  const replica = useReplica();
  if (!replica || replica.table('unit').count === 0) return null;
  return (
    <Card blur className="gm-legend" role="group" aria-label="File types and size filter">
      <TypeRows />
      <MinBytes />
      <LayerToggles />
    </Card>
  );
}

const mount: AppMount = { region: 'bottomRight', order: 10, Component: Legend };
export default mount;
