// Feature mounts: every src/app/<feature>/mount.tsx is discovered here and rendered into its region
// (contracts/app.ts). Adding a feature never edits the shell.
import { Component, type ReactNode } from 'react';
import type { AppMount, AppRegion } from '../contracts/app';
import { usePhase, type Phase } from './store';

interface FoundMount extends AppMount { key: string }

const modules = import.meta.glob<{ default?: AppMount | AppMount[] }>('./*/mount.tsx', { eager: true });

/** All mounts, lowest `order` first; ties keep folder-name order. */
export const mounts: FoundMount[] = Object.keys(modules)
  .sort()
  .flatMap((path) => {
    const exported = modules[path]!.default;
    const list = exported === undefined ? [] : Array.isArray(exported) ? exported : [exported];
    return list.map((mount, i): FoundMount => ({ ...mount, key: `${path}#${i}` }));
  })
  .sort((a, b) => a.order - b.order);

/** A mount without `phases` shows on the map, except in the landing region, which exists only on the landing page. */
function phasesOf(mount: AppMount): readonly Phase[] {
  return mount.phases ?? (mount.region === 'landing' ? ['landing'] : ['map']);
}

/** One feature failing to render must not take the map down with it. */
class MountBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(err: unknown) { console.error(`gitmap: mount ${this.props.name} failed to render`, err); }
  override render() { return this.state.failed ? null : this.props.children; }
}

/** Renders the mounts of one region for the current phase. */
export function Region({ name }: { name: AppRegion }) {
  const phase = usePhase();
  const shown = mounts.filter((m) => m.region === name && phasesOf(m).includes(phase));
  return (
    <div className={`gm-region gm-region-${name}`} data-region={name}>
      {shown.map((m) => (
        <MountBoundary key={m.key} name={m.key}>
          <m.Component />
        </MountBoundary>
      ))}
    </div>
  );
}
