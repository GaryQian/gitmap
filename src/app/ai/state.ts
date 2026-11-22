// The AI feature's own UI state: the controller, the viewer's answer about consent, the run in
// flight and the failure line. Plain functions, callable from anywhere (the settings card later).
import { create } from 'zustand';
import { getConsent, resetConsent as forgetConsent, setConsent, toAiErrorInfo } from '../../ai';
import type { Consent } from '../../ai';
import type { Session } from '../../contracts/pipeline';
import { useApp } from '../store';
import type { AiController, AiRunOutcome } from './controller';

interface AiUiState {
  /** Set with `setAiController`; null means "use the one the session offers". */
  controller: AiController | null;
  /** Counts consent changes, so components read the answer again. */
  consentRev: number;
  /** The one quiet line, until it has faded. */
  failure: { id: number; text: string } | null;
}

export const useAiUi = create<AiUiState>()(() => ({ controller: null, consentRev: 0, failure: null }));

/**
 * Put a controller in charge, or null to go back to the session's own (`session.ai`). The pipeline
 * does not need this once `Session` carries `ai`; the dev harness and tests do.
 */
export function setAiController(controller: AiController | null): void {
  useAiUi.setState({ controller });
}

// ---- consent ----

/** Answers given in this visit. They also cover a browser that refuses to store anything. */
const answered = new Map<string, Consent | null>();
/** Sessions whose generation has been started, so a re-render does not start it twice. */
const started = new WeakSet<Session>();
let running: { session: Session; controller: AiController } | null = null;

/** The viewer's answer for a repository (`RepoMeta.id`), or null when they have not answered. */
export function getAiConsent(repoId: string): Consent | null {
  return answered.has(repoId) ? answered.get(repoId)! : getConsent(repoId);
}

/** Record the viewer's answer, or forget it with null (they are then asked again when nothing is stored). */
export function setAiConsent(repoId: string, consent: Consent | null): void {
  if (consent) setConsent(repoId, consent); else forgetConsent(repoId);
  answered.set(repoId, consent);
  if (consent !== 'granted') {
    // withdrawn: stop what is running, and let a later "Allow" start again
    const { session } = useApp.getState();
    if (session) started.delete(session);
    if (running) { try { running.controller.cancel(); } catch { /* nothing to stop */ } running = null; }
  }
  useAiUi.setState((s) => ({ consentRev: s.consentRev + 1 }));
}

/** Forget the answer for a repository. For the settings card: this is how "Not now" is reversed. */
export function resetConsent(repoId: string): void {
  setAiConsent(repoId, null);
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

// ---- calls ----

/** Run one controller call; a failure becomes the quiet line if this map is still the open one. */
function call(session: Session, run: () => Promise<AiRunOutcome | void>): Promise<void> {
  const report = (failure: unknown) => { if (failure && useApp.getState().session === session) showAiFailure(failure); };
  return Promise.resolve().then(run).then((outcome) => report(outcome?.failure), report);
}

/** Start generation for a session, once. */
export function startGeneration(session: Session, controller: AiController): void {
  if (started.has(session)) return;
  started.add(session);
  const mine = { session, controller };
  running = mine;
  void call(session, () => controller.start()).finally(() => { if (running === mine) running = null; });
}

export function requestDetail(session: Session, controller: AiController, poiId: string, question: Parameters<AiController['requestDetail']>[1]): void {
  void call(session, () => controller.requestDetail(poiId, question));
}

// This module holds state (the controller, the answers). Hot-swapping it would leave two copies alive.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
