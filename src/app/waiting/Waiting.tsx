// The waiting screen (PLAN.md §6.8, §17.8): the same background, no grid, and one centred pill
// naming the current stage, with a thin line along its lower edge: the measured share when the
// stage can be measured, a travelling run when it cannot, so the screen never looks stopped.
import { useEffect, useRef, useState } from 'react';
import type { Stage, StageInfo } from '../../contracts/pipeline';
import { say } from '../status/messages';
import { STATUS_LOCAL } from '../status/tunables';
import '../status/status.css';
import { LAYER, useDismissable } from '../keys';
import { closeSession } from '../session';
import { useStage } from '../store';
import { CloseIcon, Pill, PillButton, ProgressLine, Strong } from '../ui';

/** Shown when a stage arrives without its own label. */
const STAGE_LABELS: Record<Stage, string> = {
  idle: 'Getting ready',
  manifest: 'Listing files',
  reading: 'Reading files',
  structure: 'Finding structure',
  layout: 'Settling layout',
  revealed: 'Settling layout',
  failed: 'Stopping',
};

/** "Reading files 6,214 / 10,000" → the words, and the count that gets Medium weight. */
export function splitCount(label: string): { text: string; count: string } {
  const m = /^(.*?)\s+([\d.,]+(?:\s*\/\s*[\d.,]+)?\s*%?)$/.exec(label);
  return m ? { text: m[1]!, count: m[2]! } : { text: label, count: '' };
}

export function stageFraction(stage: StageInfo): number | null {
  if (stage.done === undefined || stage.total === undefined || !(stage.total > 0)) return null;
  return Math.min(1, Math.max(0, stage.done / stage.total));
}

/** How often the line is moved while a stretch that reports nothing runs. */
const CREEP_TICK_MS = 100;
/** A stretch moved by time never quite reaches its end: the next stage does that. */
const CREEP_REACH = 0.94;

/**
 * Where the line under the pill stands, 0–1; null when the wait cannot be measured.
 *
 * It is the pipeline's one figure for the whole wait (StageInfo.overall) when there is one, so the
 * line runs once from end to end and does not start again at each stage. Through a stretch that
 * reports nothing while it runs (the analysis, the layout) it keeps moving by time, quickly at first
 * and ever more slowly, towards where that stretch ends. And it never moves backwards.
 */
export function useShownFraction(stage: StageInfo): number | null {
  const { overall, creepTo, creepMs } = stage;
  const creeping = overall !== undefined && creepTo !== undefined && !!creepMs && creepMs > 0;
  // When this stretch began. Kept beside what it belongs to, so that the render in which a new
  // stretch arrives does not move it by the time the last one had run.
  const key = `${overall}|${creepTo}|${creepMs}`;
  const began = useRef({ key: '', at: 0 });
  if (began.current.key !== key) began.current = { key, at: performance.now() };
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!creeping) return;
    const timer = setInterval(() => redraw((n) => n + 1), CREEP_TICK_MS);
    return () => clearInterval(timer);
  }, [creeping, key]);
  const creep = creeping ? 1 - Math.exp(-(performance.now() - began.current.at) / creepMs) : 0;
  const high = useRef(0);
  if (overall === undefined) {
    high.current = 0;
    return stageFraction(stage);
  }
  const moved = creepTo === undefined || !creeping ? overall : overall + (creepTo - overall) * creep * CREEP_REACH;
  high.current = Math.max(high.current, Math.min(1, Math.max(0, moved)));
  return high.current;
}

/**
 * True once the same line has been on screen for a while with nothing changing. Listing a very
 * large folder reports no count, so the page says in words that it is still at work.
 */
function useStalled(label: string): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    const timer = setTimeout(() => setStalled(true), STATUS_LOCAL.stillWorkingMs);
    return () => clearTimeout(timer);
  }, [label]);
  return stalled;
}

export function Waiting() {
  const stage = useStage();
  const label = stage.label || STAGE_LABELS[stage.stage];
  const { text, count } = splitCount(label);
  const fraction = useShownFraction(stage);
  const stalled = useStalled(label);
  // Cancel: back to the landing page. closeSession abandons the open in flight (session.ts).
  useDismissable(true, () => closeSession(), { layer: LAYER.selection });
  return (
    <div className="gm-waiting">
      <div className="gm-waiting-row">
        <Pill
          blur
          className="gm-waiting-pill"
          role="progressbar"
          aria-label={text}
          aria-valuetext={label}
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={fraction ?? undefined}
        >
          <span>{text}</span>
          {count && <Strong>{count}</Strong>}
          {fraction === null
            ? <span className="gm-line gm-line-busy" aria-hidden="true"><span /></span>
            : <ProgressLine value={fraction} />}
        </Pill>
        <PillButton round blur className="gm-waiting-cancel" aria-label="Cancel" title="Cancel and go back" onClick={() => closeSession()}>
          <CloseIcon size={14} />
        </PillButton>
      </div>
      {/* a change of stage is announced once, by its words alone: the running count is not */}
      <span className="gm-visually-hidden" role="status">{text}</span>
      <p className="gm-waiting-note" role="status">{stalled ? say('still-working').text : ''}</p>
    </div>
  );
}
