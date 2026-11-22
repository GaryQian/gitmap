// The one store for app and view state, with the hooks features use. See README.md.
import { useCallback, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { config, type ThemeMode } from '../config';
import type { Notice, Session, StageInfo } from '../contracts/pipeline';
import type { RenderApi } from '../contracts/render';
import type { ModelReplica } from '../contracts/store';
import type { NodeRef, Subsystem } from '../model/types';
import {
  clearSelection as cleared, clickSelect, focusSelected, marqueeSelect, removeSelected, replaceSelection, shiftClickSelect,
  type SelectionState,
} from './selectionState';
import { APPEARANCES, applyTheme, resolveMode, type Appearance } from './theme';

export type Phase = 'landing' | 'waiting' | 'map';
export interface Settings { appearance: Appearance; particles: boolean }
export interface ProgressEntry { done: number; total: number; label?: string }
/** A notice that is on screen ('cleared' removes one and is never stored). */
export type ShownNotice = Exclude<Notice, { kind: 'cleared' }>;

export interface AppState {
  // ---- app state ----
  phase: Phase;
  /** The open map, from "waiting" onwards. Null on the landing page. */
  session: Session | null;
  /** Counts sessions, so per-session DOM (the map canvas) can be keyed. */
  sessionId: number;
  /** Null until the map canvas is attached. */
  render: RenderApi | null;
  stage: StageInfo;
  /** Latest progress per subsystem. */
  progress: Partial<Record<Subsystem, ProgressEntry>>;
  notices: ShownNotice[];
  /** The quiet line under "Choose a folder". */
  message: string | null;
  settings: Settings;
  systemDark: boolean;
  /** Appearance resolved against the system setting. */
  mode: ThemeMode;
  reducedMotion: boolean;
  /** 0..1, brightens the background while a folder is dragged over the landing page. */
  backgroundEmphasis: number;
  // ---- view state ----
  selection: NodeRef[];
  /** The selected node the detail card describes; a member of `selection`, or null. */
  focus: NodeRef | null;
  hover: NodeRef | null;
  activeOverlay: string | null;
  /** Languages shown at full strength; empty = all. */
  typeFilter: string[];
  minLines: number;
  openFile: NodeRef | null;
}

const SETTINGS_KEY = 'starmap.settings';
export const IDLE_STAGE: StageInfo = { stage: 'idle', label: '' };

const media = (query: string): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia(query) : null;
const darkQuery = media('(prefers-color-scheme: dark)');
const motionQuery = media('(prefers-reduced-motion: reduce)');

/** `?appearance=dark|light|system` sets the mode for this visit without saving it (screenshots, links). */
function appearanceFromUrl(): Appearance | null {
  if (typeof location === 'undefined') return null;
  const asked = new URLSearchParams(location.search).get('appearance') as Appearance | null;
  return asked && APPEARANCES.includes(asked) ? asked : null;
}

function loadSettings(): Settings {
  const saved = loadSavedSettings();
  return { ...saved, appearance: appearanceFromUrl() ?? saved.appearance };
}

function loadSavedSettings(): Settings {
  const defaults: Settings = { appearance: config.settings.appearance as Appearance, particles: config.settings.particles };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (typeof saved !== 'object' || saved === null) return defaults;
    const { appearance, particles } = saved as Partial<Settings>;
    return {
      appearance: APPEARANCES.includes(appearance as Appearance) ? (appearance as Appearance) : defaults.appearance,
      particles: typeof particles === 'boolean' ? particles : defaults.particles,
    };
  } catch {
    return defaults; // no storage, or something else wrote the key
  }
}

function saveSettings(settings: Settings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode: the choice lasts for this visit */ }
}

/** View state a new map starts with. */
export function freshView(): Pick<AppState, 'selection' | 'focus' | 'hover' | 'activeOverlay' | 'typeFilter' | 'minLines' | 'openFile'> {
  return { selection: [], focus: null, hover: null, activeOverlay: null, typeFilter: [], minLines: config.legend.minLinesDefault, openFile: null };
}

const initialSettings = loadSettings();
const initialSystemDark = darkQuery?.matches ?? true;

export const useApp = create<AppState>()(() => ({
  phase: 'landing',
  session: null,
  sessionId: 0,
  render: null,
  stage: IDLE_STAGE,
  progress: {},
  notices: [],
  message: null,
  settings: initialSettings,
  systemDark: initialSystemDark,
  mode: resolveMode(initialSettings.appearance, initialSystemDark),
  reducedMotion: motionQuery?.matches ?? false,
  backgroundEmphasis: 0,
  ...freshView(),
}));

/** Apply the theme now and keep it, and the system-preference flags, up to date. Call once at start-up. */
export function initEnvironment(): void {
  applyTheme(useApp.getState().mode);
  useApp.subscribe((s, prev) => { if (s.mode !== prev.mode) applyTheme(s.mode); });
  darkQuery?.addEventListener('change', (e) => {
    useApp.setState((s) => ({ systemDark: e.matches, mode: resolveMode(s.settings.appearance, e.matches) }));
  });
  motionQuery?.addEventListener('change', (e) => useApp.setState({ reducedMotion: e.matches }));
}

// ---- actions (plain functions: call them from anywhere) ----

function setSettings(patch: Partial<Settings>): void {
  useApp.setState((s) => {
    const settings = { ...s.settings, ...patch };
    saveSettings(settings);
    return { settings, mode: resolveMode(settings.appearance, s.systemDark) };
  });
}
export function setAppearance(appearance: Appearance): void { setSettings({ appearance }); }
export function setParticles(particles: boolean): void { setSettings({ particles }); }

/** Selection changes go through the pure transitions in selectionState.ts. */
function select(change: (state: SelectionState) => SelectionState): void {
  useApp.setState((s) => {
    const next = change(s);
    return next.selection === s.selection && next.focus === s.focus ? s : { selection: next.selection, focus: next.focus };
  });
}
/** Replace the selection. A single node is also focused (its detail card opens). */
export function setSelection(selection: NodeRef[]): void { select((s) => replaceSelection(s, selection)); }
/** Click: select this node alone and focus it; null (empty space) clears. */
export function selectOnly(ref: NodeRef | null): void { select((s) => clickSelect(s, ref)); }
/** Add the ref to the selection and focus it, or remove it if it is already there (Shift+click). */
export function toggleSelection(ref: NodeRef): void { select((s) => shiftClickSelect(s, ref)); }
/** Add refs to the selection (marquee). */
export function addToSelection(refs: readonly NodeRef[]): void { select((s) => marqueeSelect(s, refs)); }
export function removeFromSelection(ref: NodeRef): void { select((s) => removeSelected(s, ref)); }
export function clearSelection(): void { select(cleared); }
/** Open the detail card on a selected node, or close it with null. */
export function setFocus(ref: NodeRef | null): void { select((s) => focusSelected(s, ref)); }
export function setHover(hover: NodeRef | null): void {
  if (useApp.getState().hover !== hover) useApp.setState({ hover });
}
export function setActiveOverlay(activeOverlay: string | null): void { useApp.setState({ activeOverlay }); }
export function setTypeFilter(typeFilter: string[]): void { useApp.setState({ typeFilter }); }
export function setMinLines(minLines: number): void { useApp.setState({ minLines }); }
export function setOpenFile(openFile: NodeRef | null): void { useApp.setState({ openFile }); }
export function setMessage(message: string | null): void { useApp.setState({ message }); }
export function setBackgroundEmphasis(backgroundEmphasis: number): void { useApp.setState({ backgroundEmphasis }); }

/** Show a notice, or act on a 'cleared' one. One pill per kind for the two actions; info lines stack. */
export function pushNotice(notice: Notice): void {
  useApp.setState((s) => {
    if (notice.kind === 'cleared') return { notices: s.notices.filter((n) => n.kind !== notice.which) };
    const same = (n: ShownNotice) =>
      n.kind === notice.kind &&
      (n.kind === 'info' && notice.kind === 'info' ? n.message === notice.message : true) &&
      (n.kind === 'no-history' && notice.kind === 'no-history' ? n.reason === notice.reason : true);
    return { notices: [...s.notices.filter((n) => !same(n)), notice] };
  });
}
export function dismissNotice(notice: ShownNotice): void {
  useApp.setState((s) => ({ notices: s.notices.filter((n) => n !== notice) }));
}

// ---- hooks ----

export const usePhase = (): Phase => useApp((s) => s.phase);
export const useSession = (): Session | null => useApp((s) => s.session);
/** The renderer of the open map; null until its canvas is attached. */
export const useRender = (): RenderApi | null => useApp((s) => s.render);
export const useStage = (): StageInfo => useApp((s) => s.stage);
export const useNotices = (): ShownNotice[] => useApp((s) => s.notices);
export const useSettings = (): Settings => useApp((s) => s.settings);
export const useThemeMode = (): ThemeMode => useApp((s) => s.mode);
export const useReducedMotion = (): boolean => useApp((s) => s.reducedMotion);
export const useSelection = (): NodeRef[] => useApp((s) => s.selection);
export const useFocus = (): NodeRef | null => useApp((s) => s.focus);
export const useHover = (): NodeRef | null => useApp((s) => s.hover);

/**
 * The replica's revision. A component that calls this re-renders after the replica applies a batch,
 * at most once per frame, so it can read `session.replica` directly while rendering.
 */
export function useReplicaVersion(): number {
  const replica = useApp((s) => s.session?.replica ?? null);
  const subscribe = useCallback((notify: () => void) => {
    if (!replica) return () => {};
    let frame = 0;
    const unsubscribe = replica.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; notify(); });
    });
    return () => { unsubscribe(); if (frame) cancelAnimationFrame(frame); };
  }, [replica]);
  return useSyncExternalStore(subscribe, () => replica?.rev ?? 0);
}

/** The open map's replica, re-rendering the caller when it changes. Null on the landing page. */
export function useReplica(): ModelReplica | null {
  useReplicaVersion();
  return useApp((s) => s.session?.replica ?? null);
}

/** The open repo's name, once the model has one. */
export function useRepoName(): string | null {
  return useReplica()?.meta?.name ?? null;
}

// This module holds state. Hot-swapping it would leave two copies alive, so reload the page instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
