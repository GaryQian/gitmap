// Development only. On the map: "Code changed · Reload" when the dev server held back a reload
// (scripts/holdReloads.ts); the map comes back after the reload (devResume.ts). On the landing page:
// "Reopen <folder>" when the last folder needs its permission granted again, which takes a click.
import { useState } from 'react';
import type { AppMount } from '../../contracts/app';
import { Pill, PillSegment } from '../ui';
import { useDevReload } from './state';

function HeldPill() {
  const { held } = useDevReload();
  if (!import.meta.env.DEV || held === 0) return null;
  return (
    <Pill blur role="status" title="The dev server is holding back page reloads while a map is open">
      <span>Code changed</span>
      <PillSegment onClick={() => location.reload()}>Reload</PillSegment>
    </Pill>
  );
}

function ReopenPill() {
  const { offer } = useDevReload();
  const [busy, setBusy] = useState(false);
  if (!import.meta.env.DEV || !offer) return null;
  return (
    <Pill blur role="status">
      <span>Last open: {offer.name}</span>
      <PillSegment disabled={busy} onClick={() => { setBusy(true); void offer.reopen().finally(() => setBusy(false)); }}>
        Reopen
      </PillSegment>
    </Pill>
  );
}

const mounts: AppMount[] = [
  { region: 'topCenter', order: 5, phases: ['waiting', 'map'], Component: HeldPill },
  { region: 'landing', order: -10, Component: ReopenPill },
];
export default mounts;
