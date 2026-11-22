// Top centre: one compact progress pill while background subsystems are still working, the action
// pills a notice raises ("Refined structure ready" + "Apply", "3 files changed" + "Update"), and the
// quiet lines: something the map wants to say once (no history here, a folder that needs choosing
// again, background work that stopped). The wording of every line is in ../status/messages.ts.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { AppMount } from '../../contracts/app';
import type { Subsystem } from '../../model/types';
import { statusLine } from '../status/actions';
import { classifyNoHistory } from '../status/classify';
import { say, type StatusCase } from '../status/messages';
import { STATUS_LOCAL } from '../status/tunables';
import {
  dismissNotice, pushNotice, useApp, useNotices, useSession, type LineAction, type ProgressEntry, type ShownNotice,
} from '../store';
import { CloseIcon, Pill, PillSegment, ProgressLine, Strong, cx } from '../ui';
import './progress.css';

const SUBSYSTEM_LABELS: Record<Subsystem, string> = {
  manifest: 'Listing files',
  fastPass: 'Reading files',
  slowPass: 'Reading structure',
  resolve: 'Linking files',
  cluster: 'Finding structure',
  layout: 'Settling layout',
  history: 'Reading history',
  workingTree: 'Checking for changes',
  ai: 'Writing notes',
  snapshot: 'Saving',
};

/** Subsystems that have reported a total and have not reached it. */
export function unfinished(progress: Partial<Record<Subsystem, ProgressEntry>>): [Subsystem, ProgressEntry][] {
  return (Object.entries(progress) as [Subsystem, ProgressEntry][]).filter(([, p]) => p.total > 0 && p.done < p.total);
}

/** Progress rounded down to a quarter, so a screen reader hears four steps, not a hundred. */
export function quarterPercent(p: Pick<ProgressEntry, 'done' | 'total'>): number {
  return Math.floor((p.done / p.total) * 4) * 25;
}

function ProgressPill() {
  const active = unfinished(useApp((s) => s.progress));
  if (active.length === 0) return null;
  // the line is the mean of the parts: totals are in different units (files, commits, calls)
  const overall = active.reduce((sum, [, p]) => sum + p.done / p.total, 0) / active.length;
  // What is seen changes every percent; what is announced changes only at each quarter.
  return (
    <Pill blur className="gm-progress" role="group" aria-label="Background work">
      {active.map(([subsystem, p]) => (
        <span className="gm-progress-part" key={subsystem} aria-hidden="true">
          <span>{p.label ?? SUBSYSTEM_LABELS[subsystem]}</span>
          <Strong>{Math.floor((p.done / p.total) * 100)}%</Strong>
        </span>
      ))}
      <span className="gm-visually-hidden" role="status">
        {active.map(([subsystem, p]) => `${p.label ?? SUBSYSTEM_LABELS[subsystem]} ${quarterPercent(p)}%`).join(', ')}
      </span>
      <ProgressLine value={overall} />
    </Pill>
  );
}

function ActionPill({ notice, verb, run, failed, children }: {
  notice: ShownNotice; verb: string; run: () => Promise<void>; failed: StatusCase; children: ReactNode;
}) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const act = async () => {
    setBusy(true);
    try {
      await run();
      dismissNotice(notice); // the session also sends 'cleared'; either one removes the pill
    } catch (err) {
      if (useApp.getState().session !== session) return; // the map was closed while this ran
      setBusy(false);
      console.warn(`starmap: "${verb}" failed`, err);
      pushNotice(statusLine(failed, { fades: true }));
    }
  };
  return (
    <Pill blur role="status">
      <span>{children}</span>
      <PillSegment disabled={busy} onClick={() => void act()}>{verb}</PillSegment>
    </Pill>
  );
}

/**
 * One quiet line: a sentence, the one thing it offers to do (if any), and a way to dismiss it. It is
 * announced politely and never takes the focus. A line that fades stays a while, then goes; resting
 * the pointer on it or focusing one of its buttons keeps it.
 */
function LinePill({ notice, text, action, fades }: { notice: ShownNotice; text: string; action?: LineAction; fades?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Stay, fade, go. The clock starts again when the line is replaced by a newer one with the same
  // id, and while it is held. (Reduced motion cuts the fade itself short, in ui.css.)
  useEffect(() => {
    setLeaving(false);
    if (!fades || held) return;
    const fade = setTimeout(() => setLeaving(true), STATUS_LOCAL.lineMs);
    const go = setTimeout(() => dismissNotice(notice), STATUS_LOCAL.lineMs + STATUS_LOCAL.fadeMs);
    return () => { clearTimeout(fade); clearTimeout(go); };
  }, [fades, held, notice]);

  const act = async () => {
    if (!action) return;
    setBusy(true);
    try { await action.run(); } catch (err) { console.warn(`starmap: "${action.label}" failed`, err); }
    setBusy(false);
  };

  return (
    <Pill
      blur
      role="status"
      className={cx('gm-info-pill', leaving && 'is-leaving')}
      style={{ '--gm-status-fade-ms': `${STATUS_LOCAL.fadeMs}ms` } as CSSProperties}
      title={text}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className="gm-info-text">{text}</span>
      {action && <PillSegment className="gm-info-action" disabled={busy} onClick={() => void act()}>{action.label}</PillSegment>}
      <PillSegment className={cx('gm-info-close', action && 'gm-info-close-after')} aria-label="Dismiss" title="Dismiss" onClick={() => dismissNotice(notice)}>
        <CloseIcon size={13} />
      </PillSegment>
    </Pill>
  );
}

function NoticePills() {
  const notices = useNotices();
  const session = useSession();
  if (!session) return null;
  return (
    <>
      {notices.map((n, i) => {
        switch (n.kind) {
          case 'refined-ready':
            return (
              <ActionPill key={n.kind} notice={n} verb="Apply" failed="apply-failed" run={() => session.applyRefined()}>
                Refined structure ready
              </ActionPill>
            );
          case 'files-changed':
            return (
              <ActionPill key={n.kind} notice={n} verb="Update" failed="update-failed" run={() => session.update()}>
                <Strong>{n.count.toLocaleString()}</Strong> {n.count === 1 ? 'file changed' : 'files changed'}
              </ActionPill>
            );
          case 'no-history':
            // why, in one line; it stays until dismissed, and the session sends it once per map
            return <LinePill key="no-history" notice={n} text={say(classifyNoHistory(n.reason)).text} />;
          case 'info':
            // the session turns the pipeline's info notices into status lines; one that arrives raw still gets a plain sentence
            return <LinePill key={`info-${i}`} notice={n} text={say('background-work-stopped').text} fades />;
          case 'status':
            return <LinePill key={`status-${n.id}`} notice={n} text={n.text} action={n.action} fades={n.fades} />;
        }
      })}
    </>
  );
}

// Search (a later package) sits first in the top centre; progress and actions follow it.
const mounts: AppMount[] = [
  { region: 'topCenter', order: 20, Component: ProgressPill },
  { region: 'topCenter', order: 30, Component: NoticePills },
];
export default mounts;
