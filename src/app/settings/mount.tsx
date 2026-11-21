// Top right, at the end of the row: the round settings pill and the card it opens (PLAN.md §17.9).
// Viewer preferences only; each applies at once and is remembered in the browser.
import { useEffect, useRef, useState } from 'react';
import type { AppMount } from '../../contracts/app';
import { setAppearance, setParticles, useSettings } from '../store';
import type { Appearance } from '../theme';
import { Card, GearIcon, PillButton, Segmented, type SegmentedOption } from '../ui';
import './settings.css';

const APPEARANCE: SegmentedOption<Appearance>[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
];
const PARTICLES: SegmentedOption<'on' | 'off'>[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

function SettingsPill() {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    // capture: the map canvas takes pointer events for itself
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="gm-settings" ref={wrap}>
      <PillButton
        ref={button}
        round
        blur
        active={open}
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Settings"
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
      </PillButton>
      {open && (
        <Card blur className="gm-settings-card" role="dialog" aria-label="Settings">
          <Segmented label="Appearance" value={settings.appearance} options={APPEARANCE} onChange={setAppearance} />
          <Segmented label="Particles" value={settings.particles ? 'on' : 'off'} options={PARTICLES} onChange={(v) => setParticles(v === 'on')} />
        </Card>
      )}
    </div>
  );
}

// 1000 keeps the gear at the end of the row, after the overlay pills.
const mount: AppMount = { region: 'topRight', order: 1000, Component: SettingsPill };
export default mount;
