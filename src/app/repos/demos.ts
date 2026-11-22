// Demos on the landing page (plan/DEMO-MODE.md §4–§6). They are listed from `config.demo.repos`,
// never from the saved-repo registry, and sit among the saved repos' pills by when each was last
// opened. A demo's identity is its place in that list: a saved repo of the same name is another pill.
import type { DemoRepo } from '../../config';
import type { SavedRepo } from './registry';

/** One JSON object, demo name → when it was last opened (epoch milliseconds). */
export const DEMOS_OPENED_KEY = 'starmap.demos.opened';

type OpenedStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): OpenedStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage is blocked for this origin
  }
}

/** When each demo was last opened in this browser. Empty when nothing was kept, or nothing can be. */
export function demosOpened(storage: OpenedStorage | null = defaultStorage()): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const saved: unknown = JSON.parse(storage?.getItem(DEMOS_OPENED_KEY) ?? 'null');
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return out;
    for (const [name, at] of Object.entries(saved)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[name] = at;
    }
  } catch {
    // no storage, or something else wrote the key: no demo has been opened
  }
  return out;
}

/** Remember that a demo was opened just now, so its pill moves to the front. */
export function markDemoOpened(name: string, at: number = Date.now(), storage: OpenedStorage | null = defaultStorage()): void {
  const opened = demosOpened(storage);
  opened[name] = at;
  try { storage?.setItem(DEMOS_OPENED_KEY, JSON.stringify(opened)); } catch { /* private mode: the order is all that is lost */ }
}

export type RepoPillItem =
  | { kind: 'saved'; key: string; repo: SavedRepo }
  | { kind: 'demo'; key: string; repo: DemoRepo };

/**
 * The landing page's pills in order: saved repos and demos together, most recently opened first;
 * demos that were never opened come after everything else, in the order config lists them. Nothing
 * is merged by name: a saved repo and a demo called the same are two pills.
 */
export function orderPills(saved: readonly SavedRepo[], demos: readonly DemoRepo[], opened: Readonly<Record<string, number>>): RepoPillItem[] {
  const dated: { item: RepoPillItem; at: number }[] = saved.map((repo) => ({ item: { kind: 'saved', key: `saved:${repo.id}`, repo }, at: repo.lastOpened }));
  const never: RepoPillItem[] = [];
  for (const repo of demos) {
    const item: RepoPillItem = { kind: 'demo', key: `demo:${repo.name}`, repo };
    const at = Object.hasOwn(opened, repo.name) ? opened[repo.name]! : null;
    if (at === null) never.push(item); else dated.push({ item, at });
  }
  // the sort is stable: at the same instant a saved repo stays before a demo
  dated.sort((a, b) => b.at - a.at);
  return [...dated.map((d) => d.item), ...never];
}
