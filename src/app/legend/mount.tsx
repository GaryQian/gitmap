// Bottom right: the file-type legend and the minimum-lines slider in one translucent card
// (PLAN.md §9, §17.6). A row isolates its type (Shift+click for several); the slider hides small,
// unimportant files without moving anything.
import { useId, useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import { config } from '../../config';
import type { AppMount } from '../../contracts/app';
import { languageColor } from '../../shared';
import { setMinLines, setTypeFilter, useApp, useReplica, useReplicaVersion } from '../store';
import { APP_LOCAL } from '../tunables';
import { Card, Strong, cx } from '../ui';
import { countLabel, languageName } from '../units';
import { countBelow, hideableLines, languageCounts, linesToSlider, nextTypeFilter, sliderToLines } from './slider';
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
    <ul className="gm-legend-rows" aria-label="File types. Select one to isolate it; hold Shift to choose several.">
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
              title={on ? 'Show all types again' : `Show only ${name} (Shift+click to add)`}
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

function MinLines() {
  const replica = useReplica();
  const rev = useReplicaVersion();
  const minLines = useApp((s) => s.minLines);
  const id = useId();

  const { maxLines, hideable, total } = useMemo(() => {
    if (!replica) return { maxLines: 0, hideable: [] as number[], total: 0 };
    const units = replica.table('unit');
    const live = (slot: number) => units.ids[slot] != null;
    let max = 0;
    for (let i = 0; i < units.capacity; i++) if (live(i) && units.cols.loc[i]! > max) max = units.cols.loc[i]!;
    return { maxLines: max, hideable: hideableLines(units.cols.loc, units.cols.importancePct, config.visual, live), total: units.count };
  }, [replica, rev]);

  // The thumb keeps its own position: several positions round to the same line count at the low
  // end, and a thumb driven by the rounded value would jump under the pointer.
  const [step, setStep] = useState(() => Math.round(linesToSlider(minLines, maxLines) * STEPS));
  const shownStep = sliderToLines(step / STEPS, maxLines) === Math.min(minLines, maxLines)
    ? step
    : Math.round(linesToSlider(minLines, maxLines) * STEPS); // the threshold or the model changed elsewhere

  const hidden = countBelow(hideable, minLines);
  const summary = hidden === 0 ? 'Showing every file' : `Hiding ${hidden.toLocaleString()} of ${countLabel(total, 'file', 'files')}`;

  return (
    <div className="gm-minlines">
      <div className="gm-minlines-head">
        <label htmlFor={id}>Minimum lines</label>
        <Strong>{minLines.toLocaleString()}</Strong>
      </div>
      <input
        id={id}
        className="gm-slider"
        type="range"
        min={0}
        max={STEPS}
        step={1}
        value={shownStep}
        disabled={maxLines === 0}
        style={{ '--gm-slider-fill': `${(shownStep / STEPS) * 100}%` } as CSSProperties}
        aria-valuetext={`${countLabel(minLines, 'line', 'lines')}. ${summary}`}
        onChange={(e) => {
          const next = Number(e.target.value);
          setStep(next);
          setMinLines(sliderToLines(next / STEPS, maxLines));
        }}
      />
      <div className="gm-minlines-summary" aria-live="polite">{summary}</div>
    </div>
  );
}

function Legend() {
  const replica = useReplica();
  if (!replica || replica.table('unit').count === 0) return null;
  return (
    <Card blur className="gm-legend" role="group" aria-label="File types and size filter">
      <TypeRows />
      <MinLines />
    </Card>
  );
}

const mount: AppMount = { region: 'bottomRight', order: 10, Component: Legend };
export default mount;
