// The AI feature's own UI state: the controller, the viewer's answer about consent and the failure
// line. Plain functions, callable from anywhere. The rules themselves (who may call what, and when)
// are in flow.ts; this file gives them the browser's storage and the app's stores.
import { create } from 'zustand';
import { toAiErrorInfo } from '../../ai';
import type { Consent } from '../../ai';
import type { Session } from '../../contracts/pipeline';
import { useApp } from '../store';
import { sessionController } from './controller';
import type { AiController } from './controller';
import { createAiFlow } from './flow';
import type { AiMap } from './flow';

interface AiUiState {
  /** Set with `setAiController`; null means "use the one the session offers". */
  controller: AiController | null;
  /** Counts changes to the answers and to whether a run is out, so components read them again. */
  rev: number;
  /** The one quiet line, until it has faded. */
  failure: { id: number; text: string } | null;
}

export const useAiUi = create<AiUiState>()(() => ({ controller: null, rev: 0, failure: null }));

/**
 * Put a controller in charge, or null to go back to the session's own (`session.ai`). The pipeline
 * does not need this once `Session` carries `ai`; the dev harness and tests do.
 */
export function setAiController(controller: AiController | null): void {
  useAiUi.setState({ controller });
}

// ---- the failure line ----

let failures = 0;

/** Show one quiet line for a failure. A cancelled request is not one. */
export function showAiFailure(err: unknown): void {
  const info = toAiErrorInfo(err);
  if (info.code === 'aborted') return;
  useAiUi.setState({ failure: { id: ++failures, text: info.message } });
}

export function clearAiFailure(id?: number): void {
  const { failure } = useAiUi.getState();
  if (failure && (id === undefined || failure.id === id)) useAiUi.setState({ failure: null });
}

// ---- consent, and the calls it allows ----

const flow = createAiFlow({
  onChange: () => useAiUi.setState((s) => ({ rev: s.rev + 1 })),
  // a line about one map does not follow the viewer to the next
  onFailure: (map, failure) => { if (useApp.getState().session === map.key) showAiFailure(failure); },
});

/** The map on screen as the flow sees it, or null before its model has arrived. */
function mapOf(session: Session | null, controller?: AiController): AiMap | null {
  const repoId = session?.replica.meta?.id;
  if (!session || repoId === undefined) return null;
  return { key: session, repoId, controller: controller ?? useAiUi.getState().controller ?? sessionController(session) };
}

/** The viewer's answer for a repository (`RepoMeta.id`), or null when they have not answered. */
export function getAiConsent(repoId: string): Consent | null {
  return flow.consent(repoId);
}

/**
 * Record the viewer's answer, or forget it with null (they are then asked again when nothing is
 * stored). An answer other than `granted` for the open map's repository stops what is running there.
 */
export function setAiConsent(repoId: string, consent: Consent | null): void {
  flow.answer(repoId, consent, mapOf(useApp.getState().session));
}

/** Forget the answer for a repository, so the viewer is asked again. */
export function resetConsent(repoId: string): void {
  setAiConsent(repoId, null);
}

/** Start generation for a session, once, if the viewer has agreed for its repository. */
export function startGeneration(session: Session, controller: AiController): void {
  const map = mapOf(session, controller);
  if (map) flow.start(map);
}

export function requestDetail(session: Session, controller: AiController, poiId: string, question: Parameters<AiController['requestDetail']>[1]): void {
  const map = mapOf(session, controller);
  if (map) flow.detail(map, poiId, question);
}

/**
 * Turn AI on or off for the open map: the settings card's "AI notes" row, the consent card's two
 * buttons and the prompt pill all come through here. Off stores `declined` and cancels what is in
 * flight; On stores `granted` and starts generation. Notes already written stay either way.
 */
export function switchAi(session: Session, controller: AiController, to: 'on' | 'off'): void {
  const map = mapOf(session, controller);
  if (!map) return;
  if (to === 'on') flow.turnOn(map); else flow.turnOff(map);
}

/** Start generation again for a map whose last run left no notes ("Write AI notes"). */
export function retryGeneration(session: Session, controller: AiController): void {
  const map = mapOf(session, controller);
  if (map) flow.retry(map);
}

/**
 * A generation run is out for this session, or is about to be started (consent is given and the
 * first `start` has not been made yet). Read again when `useAiUi`'s `rev` changes.
 */
export function generationPending(session: Session): boolean {
  return !flow.started(session) || flow.running(session);
}

// Work reported for a map whose AI is off is cancelled (see `AiFlow.progressed`).
useApp.subscribe((state, before) => {
  const progress = state.progress.ai;
  if (!progress || progress === before.progress.ai) return;
  const map = mapOf(state.session);
  if (map) flow.progressed(map, progress);
});

// This module holds state (the controller, the answers). Hot-swapping it would leave two copies alive.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
