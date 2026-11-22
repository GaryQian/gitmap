// The rules between the viewer's answer and the calls that may be made (PLAN.md §11.4), kept apart
// from the stores so they run in a test: the answer per repository, starting generation once,
// turning AI off and on again for the open map. state.ts holds the one instance the chrome uses.
//
// The rule everything here keeps: no call reaches a controller unless the stored answer for that
// map's repository is `granted`.
import { getConsent, resetConsent, setConsent } from '../../ai';
import type { Consent, ConsentStorage } from '../../ai';
import type { DetailQuestion } from '../../contracts/ai';
import type { AiController, AiRunOutcome } from './controller';

/** The open map as the flow needs it. */
export interface AiMap {
  /** Identity of the open map (the `Session`): generation starts once per key while AI is on. */
  key: object;
  /** `RepoMeta.id`: answers are kept per repository. */
  repoId: string;
  controller: AiController;
}

export interface AiFlowOptions {
  /** Where answers are kept. Default: this browser's `localStorage`. */
  storage?: ConsentStorage | null;
  /** Something a component reads here changed: an answer, or whether a run is in flight. */
  onChange?: () => void;
  /** A call ended with a failure (resolved as `{ failure }`, or thrown) while AI was still on for its map. */
  onFailure?: (map: AiMap, failure: unknown) => void;
}

export interface AiFlow {
  /** The viewer's answer for a repository, or null when they have not answered. */
  consent(repoId: string): Consent | null;
  /**
   * Record an answer, or forget it with null. `open` is the map on screen, if any: when the answer
   * for its repository stops being `granted`, what is running there is cancelled.
   */
  answer(repoId: string, consent: Consent | null, open?: AiMap | null): void;
  /** Start generation for a map, once, and only with consent. */
  start(map: AiMap): void;
  /**
   * Start generation again after a run that left nothing (it failed, or could not start). Only
   * with consent, and not while a run is still out.
   */
  retry(map: AiMap): void;
  /** True from `start` (or `retry`) until that call has resolved or rejected. */
  running(key: object): boolean;
  /** True once generation has been started for this map at least once since AI was last turned on. */
  started(key: object): boolean;
  /** Ask for one detail, only with consent. */
  detail(map: AiMap, poiId: string, question: DetailQuestion): void;
  /**
   * "On" in the settings card, "Allow for this repo" on the consent card, the prompt pill: the
   * answer becomes `granted` and generation starts (a set already stored for this digest makes no
   * request). Nothing happens when it is on already.
   */
  turnOn(map: AiMap): void;
  /**
   * "Off" in the settings card, "Not now" on the consent card: the answer becomes `declined`, so
   * nothing more is asked of the controller, and whatever a granted answer left in flight is
   * cancelled, once. Notes already on the map stay.
   */
  turnOff(map: AiMap): void;
  /**
   * The `ai` subsystem reported progress for the open map. Work that shows up while AI is off there
   * (a `start` that was still waiting for the parse when it was turned off, so there was nothing to
   * cancel yet) is cancelled now.
   */
  progressed(map: AiMap, progress: { done: number; total: number }): void;
}

export function createAiFlow(options: AiFlowOptions = {}): AiFlow {
  const { storage } = options;
  // an explicit null means "no storage"; leaving it out means the browser's own
  const read = (repoId: string) => (storage === undefined ? getConsent(repoId) : getConsent(repoId, storage));
  const write = (repoId: string, consent: Consent | null) => {
    if (consent === null) { if (storage === undefined) resetConsent(repoId); else resetConsent(repoId, storage); return; }
    if (storage === undefined) setConsent(repoId, consent); else setConsent(repoId, consent, storage);
  };

  /** Answers given in this visit. They also cover a browser that refuses to store anything. */
  const answered = new Map<string, Consent | null>();
  /** Maps whose generation has been started, so a re-render does not start it twice. */
  const begun = new WeakSet<object>();
  /** `start` calls that have not come back yet, per map. */
  const out = new WeakMap<object, number>();

  const consent = (repoId: string): Consent | null => (answered.has(repoId) ? answered.get(repoId)! : read(repoId));
  const on = (map: AiMap): boolean => consent(map.repoId) === 'granted';
  const running = (key: object): boolean => (out.get(key) ?? 0) > 0;

  const cancel = (map: AiMap): void => {
    try { map.controller.cancel(); } catch { /* nothing to stop */ }
  };

  /**
   * Run one controller call, at once (a cancel that follows must not overtake it). A failure is
   * reported unless AI was turned off for the map meanwhile.
   */
  const run = (map: AiMap, call: () => Promise<AiRunOutcome | void>): Promise<void> => {
    const report = (failure: unknown) => { if (failure && on(map)) options.onFailure?.(map, failure); };
    let result: Promise<AiRunOutcome | void>;
    try { result = Promise.resolve(call()); } catch (err) { result = Promise.reject(err); }
    return result.then((outcome) => report(outcome?.failure), report);
  };

  const generate = (map: AiMap): void => {
    begun.add(map.key);
    out.set(map.key, (out.get(map.key) ?? 0) + 1);
    options.onChange?.();
    void run(map, () => map.controller.start()).finally(() => {
      out.set(map.key, Math.max(0, (out.get(map.key) ?? 1) - 1));
      options.onChange?.();
    });
  };

  const answer = (repoId: string, next: Consent | null, open?: AiMap | null): void => {
    const before = consent(repoId);
    write(repoId, next);
    answered.set(repoId, next);
    if (next !== 'granted' && open && open.repoId === repoId) {
      begun.delete(open.key); // a later "On" starts again
      // only a granted answer can have left something running
      if (before === 'granted') cancel(open);
    }
    options.onChange?.();
  };

  const start = (map: AiMap): void => {
    if (on(map) && !begun.has(map.key)) generate(map);
  };

  return {
    consent,
    answer,
    start,
    retry(map) {
      if (on(map) && !running(map.key)) generate(map);
    },
    running,
    started: (key) => begun.has(key),
    detail(map, poiId, question) {
      if (on(map)) void run(map, () => map.controller.requestDetail(poiId, question));
    },
    turnOn(map) {
      if (on(map)) return;
      answer(map.repoId, 'granted', map);
      start(map);
    },
    turnOff(map) {
      if (consent(map.repoId) === 'declined') return;
      answer(map.repoId, 'declined', map);
    },
    progressed(map, progress) {
      if (!on(map) && progress.total > 0 && progress.done < progress.total) cancel(map);
    },
  };
}
