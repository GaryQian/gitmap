// Top right, at the end of the row: the round settings pill and the card it opens (PLAN.md §17.9).
// Viewer preferences only; each applies at once and is remembered in the browser.
import { useEffect, useId, useRef, useState } from 'react';
import type { AppMount } from '../../contracts/app';
import { AiSettingsRow } from '../ai';
import { LAYER, useDismissable } from '../keys';
import { setParticles, useSession, useSettings } from '../store';
import { Card, GearIcon, PillButton, Segmented, Strong, type SegmentedOption } from '../ui';
import { ExportRow } from './ExportRow';
import { resetRepo, resetTarget } from './reset';
import './settings.css';

const PARTICLES: SegmentedOption<'on' | 'off'>[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

/** Re-parse the open repo from its folder, after deleting what was saved for it. Asks once first. */
function ResetRow() {
  const session = useSession();
  const target = resetTarget(session);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setConfirming(false); setBusy(false); }, [session]);

  return (
    <div className="gm-field gm-reset">
      <div className="gm-field-label">Repository</div>
      {!confirming ? (
        <PillButton
          size="small"
          className="gm-reset-button"
          disabled={!target}
          title={target ? 'Delete the saved map and parse the folder again' : 'Only a map opened from a folder can be parsed again'}
          onClick={() => setConfirming(true)}
        >
          Reset and re-parse
        </PillButton>
      ) : (
        <div className="gm-reset-confirm" role="group" aria-label="Confirm reset">
          <p className="gm-reset-note">
            Deletes the saved map, history and parse cache for <Strong>{target?.name}</Strong>, then parses the folder from scratch.
          </p>
          <div className="gm-reset-actions">
            <PillButton size="small" onClick={() => setConfirming(false)} disabled={busy}>Cancel</PillButton>
            <PillButton
              size="small"
              className="gm-reset-go"
              disabled={busy || !target}
              onClick={() => {
                if (!target) return;
                setBusy(true);
                void resetRepo(target);
              }}
            >
              Reset
            </PillButton>
          </div>
        </div>
      )}
      {!target && <p className="gm-reset-note">Needs a map opened from a folder</p>}
    </div>
  );
}

function SettingsPill() {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const cardId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // capture: the map canvas takes pointer events for itself
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  // Escape closes the card (one layer per press, keys.ts) and gives the focus back to the gear
  useDismissable(open, () => {
    setOpen(false);
    button.current?.focus();
  }, { layer: LAYER.card });

  return (
    <div className="gm-settings" ref={wrap}>
      <PillButton
        ref={button}
        round
        blur
        active={open}
        aria-label="Settings"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        title="Settings"
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
      </PillButton>
      {open && (
        // not a dialog: it does not hold the focus, and the rest of the map stays in reach
        <Card blur id={cardId} className="gm-settings-card" role="group" aria-label="Settings">
          <Segmented label="Particles" value={settings.particles ? 'on' : 'off'} options={PARTICLES} onChange={(v) => setParticles(v === 'on')} />
          <AiSettingsRow />
          <ExportRow />
          <ResetRow />
        </Card>
      )}
    </div>
  );
}

// 1000 keeps the gear at the end of the row, after the overlay pills.
const mount: AppMount = { region: 'topRight', order: 1000, Component: SettingsPill };
export default mount;
