// Top centre: one compact progress pill while background subsystems are still working, and the
// action pills a notice raises ("Refined structure ready" + "Apply", "3 files changed" + "Update").
import { useState, type ReactNode } from 'react';
import type { AppMount } from '../../contracts/app';
import type { Subsystem } from '../../model/types';
import { errorMessage } from '../session';
import { dismissNotice, pushNotice, useApp, useNotices, useSession, type ProgressEntry, type ShownNotice } from '../store';
import { CloseIcon, Pill, PillSegment, ProgressLine, Strong } from '../ui';
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

function ProgressPill() {
  const active = unfinished(useApp((s) => s.progress));
  if (active.length === 0) return null;
  // the line is the mean of the parts: totals are in different units (files, commits, calls)
  const overall = active.reduce((sum, [, p]) => sum + p.done / p.total, 0) / active.length;
  return (
    <Pill blur className="gm-progress" role="status" aria-label="Background work">
      {active.map(([subsystem, p]) => (
        <span className="gm-progress-part" key={subsystem}>
          <span>{p.label ?? SUBSYSTEM_LABELS[subsystem]}</span>
          <Strong>{Math.floor((p.done / p.total) * 100)}%</Strong>
        </span>
      ))}
      <ProgressLine value={overall} />
    </Pill>
  );
}

function ActionPill({ notice, verb, run, children }: { notice: ShownNotice; verb: string; run: () => Promise<void>; children: ReactNode }) {
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
      pushNotice({ kind: 'info', message: errorMessage(err) });
    }
  };
  return (
    <Pill blur role="status">
      <span>{children}</span>
      <PillSegment disabled={busy} onClick={() => void act()}>{verb}</PillSegment>
    </Pill>
  );
}

function InfoPill({ notice, text }: { notice: ShownNotice; text: string }) {
  return (
    <Pill blur role="status" className="gm-info-pill">
      <span className="gm-info-text">{text}</span>
      <PillSegment className="gm-info-close" aria-label="Dismiss" title="Dismiss" onClick={() => dismissNotice(notice)}>
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
            return <ActionPill key={n.kind} notice={n} verb="Apply" run={() => session.applyRefined()}>Refined structure ready</ActionPill>;
          case 'files-changed':
            return (
              <ActionPill key={n.kind} notice={n} verb="Update" run={() => session.update()}>
                <Strong>{n.count.toLocaleString()}</Strong> {n.count === 1 ? 'file changed' : 'files changed'}
              </ActionPill>
            );
          case 'no-history':
            return <InfoPill key={`history-${i}`} notice={n} text={n.reason} />;
          case 'info':
            return <InfoPill key={`info-${i}`} notice={n} text={n.message} />;
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
