// The main thread's handle on the AI orchestration. The orchestration itself runs in the coordinator
// worker (the digest needs the parse facts, which live only there); the chrome asks for it through
// this small interface and never imports the worker's side.
import type { AiErrorInfo } from '../../ai';
import type { DetailQuestion } from '../../contracts/ai';
import type { Session } from '../../contracts/pipeline';

/** What a call may resolve with: the one failure worth a line in the chrome, if there was one. */
export interface AiRunOutcome { failure?: AiErrorInfo | null }

export interface AiController {
  /**
   * False when this map cannot generate anything: a demo, an imported map without its folder, a
   * session without the AI wiring. Read again whenever the model changes, so it may become true.
   */
  readonly available: boolean;
  /**
   * Generate what is missing for the current digest: summaries, points of interest, the tour. Safe
   * to call on every visit (a complete stored set makes no request). It waits for the full parse
   * itself. Resolves when the run is over; the results arrive through the model. A failure is
   * either resolved as `{ failure }` or thrown as something with a `code` (see `toAiErrorInfo`).
   */
  start(): Promise<AiRunOutcome | void>;
  /** Answer one detail button. The answer arrives through the model, as `poi.details[question]`. */
  requestDetail(poiId: string, question: DetailQuestion): Promise<AiRunOutcome | void>;
  /** Stop a run in flight. Called when the viewer withdraws consent. */
  cancel(): void;
}

export const NO_AI: AiController = {
  available: false,
  start: async () => {},
  requestDetail: async () => {},
  cancel() {},
};

const adapters = new WeakMap<object, AiController>();

/**
 * The controller a session offers as an optional `ai` property, found by shape so the `Session`
 * contract does not have to change first. `NO_AI` when there is none.
 */
export function sessionController(session: Session | null): AiController {
  const ai: unknown = (session as { ai?: unknown } | null)?.ai;
  if (typeof ai !== 'object' || ai === null) return NO_AI;
  const found = ai as Partial<AiController>;
  if (typeof found.start !== 'function' || typeof found.requestDetail !== 'function') return NO_AI;
  let adapter = adapters.get(ai);
  if (!adapter) {
    adapter = {
      get available() { return found.available !== false; },
      start: () => found.start!(),
      requestDetail: (poiId, question) => found.requestDetail!(poiId, question),
      cancel: () => { found.cancel?.(); },
    };
    adapters.set(ai, adapter);
  }
  return adapter;
}
