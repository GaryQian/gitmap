// The waiting screen (PLAN.md §6.8, §17.8): the same background, no grid, and one centred pill
// naming the current stage, with a thin line along its lower edge when the stage can be measured.
import type { Stage, StageInfo } from '../../contracts/pipeline';
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

export function Waiting() {
  const stage = useStage();
  const label = stage.label || STAGE_LABELS[stage.stage];
  const { text, count } = splitCount(label);
  const fraction = stageFraction(stage);
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
        <ProgressLine value={fraction} />
      </Pill>
    </div>
  );
}
