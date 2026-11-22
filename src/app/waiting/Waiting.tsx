// The waiting screen (PLAN.md §6.8, §17.8): the same background, no grid, and one centred pill
// naming the current stage, with a thin line along its lower edge: the measured share when the
// stage can be measured, a travelling run when it cannot, so the screen never looks stopped.
import { useEffect, useState } from 'react';
import type { Stage, StageInfo } from '../../contracts/pipeline';
import { say } from '../status/messages';
import { STATUS_LOCAL } from '../status/tunables';
import '../status/status.css';
import { useStage } from '../store';
import { Pill, ProgressLine, Strong } from '../ui';

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
  const fraction = stageFraction(stage);
  const stalled = useStalled(label);
  return (
    <div className="gm-waiting">
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
      <p className="gm-waiting-note" role="status">{stalled ? say('still-working').text : ''}</p>
    </div>
  );
}
