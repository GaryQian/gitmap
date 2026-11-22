// The reader's own state: its width and whether markdown opens as a preview. Kept in the browser,
// apart from the app store, because nothing outside this folder reads it.
import { create } from 'zustand';
import { SIDEBAR_LOCAL as T } from './tunables';

export type MarkdownView = 'preview' | 'source';
export interface ReaderPrefs { width: number; markdown: MarkdownView }

const DEFAULTS: ReaderPrefs = { width: T.widthDefaultPx, markdown: 'preview' };

function load(): ReaderPrefs {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(T.storageKey) ?? 'null');
    if (typeof saved !== 'object' || saved === null) return DEFAULTS;
    const { width, markdown } = saved as Partial<ReaderPrefs>;
    return {
      width: typeof width === 'number' && Number.isFinite(width) ? width : DEFAULTS.width,
      markdown: markdown === 'source' ? 'source' : 'preview',
    };
  } catch {
    return DEFAULTS; // no storage, or something else wrote the key
  }
}

function save(prefs: ReaderPrefs): void {
  try { localStorage.setItem(T.storageKey, JSON.stringify(prefs)); } catch { /* private mode: lasts for this visit */ }
}

export const usePrefs = create<ReaderPrefs>()(() => load());

/** Set the width. A drag passes `persist: false` while it moves and saves once at the end. */
export function setWidth(width: number, persist = true): void {
  usePrefs.setState({ width: Math.round(width) });
  if (persist) save(usePrefs.getState());
}

export function setMarkdownView(markdown: MarkdownView): void {
  usePrefs.setState({ markdown });
  save(usePrefs.getState());
}

/** The widest the reader may be in a window this wide: the map keeps `mapMinPx`. Never below the minimum. */
export function maxWidthFor(viewportWidth: number): number {
  return Math.max(T.widthMinPx, Math.min(T.widthMaxPx, viewportWidth - T.mapMinPx));
}

export function clampWidth(width: number, viewportWidth: number): number {
  return Math.min(maxWidthFor(viewportWidth), Math.max(T.widthMinPx, Math.round(width)));
}
