// Top right, at the end of the row: the round settings pill and the card it opens (PLAN.md §17.9).
// Viewer preferences only; each applies at once and is remembered in the browser.
import { useEffect, useId, useRef, useState } from 'react';
import type { AppMount } from '../../contracts/app';
import { AiSettingsRow } from '../ai';
import { LAYER, useDismissable } from '../keys';
import { setParticles, useSettings } from '../store';
import { Card, GearIcon, PillButton, Segmented, type SegmentedOption } from '../ui';
import './settings.css';

const PARTICLES: SegmentedOption<'on' | 'off'>[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

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
        </Card>
      )}
    </div>
  );
}

// 1000 keeps the gear at the end of the row, after the overlay pills.
const mount: AppMount = { region: 'topRight', order: 1000, Component: SettingsPill };
export default mount;
