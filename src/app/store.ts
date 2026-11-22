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
import { applyTheme } from './theme';

export type Phase = 'landing' | 'waiting' | 'map';
export interface Settings { particles: boolean }
export interface ProgressEntry { done: number; total: number; label?: string }
/** The one thing a line offers to do: "Reload", "Choose the folder". */
export interface LineAction { label: string; run(): void | Promise<void> }
/**
 * A line the shell itself raises on the map (src/app/status has the wording): an error that did not
 * end the map, a folder that needs choosing again. One per `id`; a later one replaces it.
 */
export interface StatusLine {
  kind: 'status';
  id: string;
  text: string;
  action?: LineAction;
  /** Goes away by itself after a while (APP_LOCAL.status); without it the line stays until dismissed. */
  fades?: boolean;
}
/** A notice that is on screen ('cleared' removes one and is never stored). */
export type ShownNotice = Exclude<Notice, { kind: 'cleared' }> | StatusLine;

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
  /** What that line offers to do about it ("Reload"), if anything. */
  messageAction: LineAction | null;
  /** The map's WebGL context is lost (the canvas says so); the scene is not being drawn. */
  contextLost: boolean;
  settings: Settings;
  /** Always 'dark' for now: light mode is switched off (its tokens stay in config.theme.light). */
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
  minBytes: number;
  openFile: NodeRef | null;
}

const SETTINGS_KEY = 'starmap.settings';
export const IDLE_STAGE: StageInfo = { stage: 'idle', label: '' };

const media = (query: string): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia(query) : null;
const motionQuery = media('(prefers-reduced-motion: reduce)');

function loadSettings(): Settings {
  const defaults: Settings = { particles: config.settings.particles };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (typeof saved !== 'object' || saved === null) return defaults;
    const { particles } = saved as Partial<Settings>;
    return {
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
export function freshView(): Pick<AppState, 'selection' | 'focus' | 'hover' | 'activeOverlay' | 'typeFilter' | 'minBytes' | 'openFile'> {
  return { selection: [], focus: null, hover: null, activeOverlay: null, typeFilter: [], minBytes: config.legend.minBytesDefault, openFile: null };
}

const initialSettings = loadSettings();

export const useApp = create<AppState>()(() => ({
  phase: 'landing',
  session: null,
  sessionId: 0,
  render: null,
  stage: IDLE_STAGE,
  progress: {},
  notices: [],
  message: null,
  messageAction: null,
  contextLost: false,
  settings: initialSettings,
  mode: 'dark',
  reducedMotion: motionQuery?.matches ?? false,
  backgroundEmphasis: 0,
  ...freshView(),
}));

/** Apply the theme now and keep the reduced-motion flag up to date. Call once at start-up. */
export function initEnvironment(): void {
  applyTheme(useApp.getState().mode);
  motionQuery?.addEventListener('change', (e) => useApp.setState({ reducedMotion: e.matches }));
}

// ---- actions (plain functions: call them from anywhere) ----

function setSettings(patch: Partial<Settings>): void {
  useApp.setState((s) => {
    const settings = { ...s.settings, ...patch };
    saveSettings(settings);
    return { settings };
  });
}
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
export function setMinBytes(minBytes: number): void { useApp.setState({ minBytes }); }
export function setOpenFile(openFile: NodeRef | null): void { useApp.setState({ openFile }); }
export function setMessage(message: string | null, action: LineAction | null = null): void {
  useApp.setState({ message, messageAction: message === null ? null : action });
}
export function setContextLost(contextLost: boolean): void {
  if (useApp.getState().contextLost !== contextLost) useApp.setState({ contextLost });
}
export function setBackgroundEmphasis(backgroundEmphasis: number): void { useApp.setState({ backgroundEmphasis }); }

/**
 * Show a notice, or act on a 'cleared' one. One pill per kind for the two actions; info lines stack;
 * a status line replaces the one with the same id.
 */
export function pushNotice(notice: Notice | StatusLine): void {
  useApp.setState((s) => {
    if (notice.kind === 'cleared') return { notices: s.notices.filter((n) => n.kind !== notice.which) };
    const same = (n: ShownNotice) =>
      n.kind === notice.kind &&
      (n.kind === 'info' && notice.kind === 'info' ? n.message === notice.message : true) &&
      (n.kind === 'no-history' && notice.kind === 'no-history' ? n.reason === notice.reason : true) &&
      (n.kind === 'status' && notice.kind === 'status' ? n.id === notice.id : true);
    return { notices: [...s.notices.filter((n) => !same(n)), notice] };
  });
}
export function dismissNotice(notice: ShownNotice): void {
  useApp.setState((s) => ({ notices: s.notices.filter((n) => n !== notice) }));
}
/** Take a status line off the screen by its id. Does nothing when it is not there. */
export function dismissStatus(id: string): void {
  useApp.setState((s) => {
    const notices = s.notices.filter((n) => !(n.kind === 'status' && n.id === id));
    return notices.length === s.notices.length ? s : { notices };
  });
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
