// What the chrome shows about AI for the open map, as pure rules: the prompt at the bottom centre
// (the consent card, or the pill that stands in for it) and the "AI notes" row of the settings card.
// Both read the same stored answer, so they cannot disagree.
import { aiAllowed, hasStoredAnnotations, shouldAsk } from '../../ai';
import type { Consent } from '../../ai';
import type { Config } from '../../config';
import type { Annotation, RepoMeta } from '../../model/types';

/** Calls finished out of calls to make: the store's `progress.ai`. */
export interface AiWork { done: number; total: number }

/** Work reported and not yet finished. */
export function inFlight(progress: AiWork | undefined): boolean {
  return progress !== undefined && progress.total > 0 && progress.done < progress.total;
}

interface AiFacts {
  config: Config;
  /** The open map's meta, or null before the model has arrived. */
  meta: Pick<RepoMeta, 'id' | 'source' | 'digestHash'> | null;
  /** `AiController.available`: this map can generate (not an imported map without its folder, say). */
  available: boolean;
  /** The stored answer for this map's repository. */
  consent: Consent | null;
}

/** AI can run here: it is enabled, the map is not a demo, and there is a controller to ask. */
export function aiCanRun(facts: Pick<AiFacts, 'config' | 'meta' | 'available'>): boolean {
  return aiAllowed(facts.config, facts.meta) && facts.available;
}

// ---- the prompt at the bottom centre ----

export const PROMPT_WORDS = {
  /** Declined, nothing on the map yet. */
  add: 'Add AI notes',
  /** Not on, but an earlier visit left notes on the map. */
  turnOn: 'Turn on AI notes',
  /** On, yet the map has no notes: the last run failed or could not start. */
  write: 'Write AI notes',
} as const;

export type AiPrompt =
  | { kind: 'none' }
  /** The full consent card: "Not now" / "Allow for this repo". */
  | { kind: 'card' }
  /**
   * One compact pill in the card's place. `allow` stores `granted` and starts generation (the same
   * path as "Allow for this repo" and the settings row's On); `retry` starts generation again.
   */
  | { kind: 'pill'; label: string; action: 'allow' | 'retry' };

export interface AiPromptFacts extends AiFacts {
  annotations: readonly Annotation[];
  /** A generation run is out, or about to be: the progress pill speaks for it. */
  busy: boolean;
}

/**
 * There is always a way to get AI notes while the map has none and AI could write them:
 *   unanswered, no notes         the consent card
 *   declined                     a pill: "Add AI notes", or "Turn on AI notes" when notes exist
 *   unanswered, notes stored     a pill: "Turn on AI notes"
 *   granted, idle, no notes      a pill: "Write AI notes" (the run failed or could not start)
 *   granted with notes, or busy  nothing: the progress pill and the tour pill take over
 *   AI cannot run here           nothing
 */
export function aiPrompt(facts: AiPromptFacts): AiPrompt {
  if (!aiCanRun(facts)) return { kind: 'none' };
  const { config, meta, annotations, consent } = facts;
  const notes = hasStoredAnnotations(meta, annotations);
  if (consent === 'granted') {
    return notes || facts.busy ? { kind: 'none' } : { kind: 'pill', label: PROMPT_WORDS.write, action: 'retry' };
  }
  if (shouldAsk({ config, meta, annotations, consent })) return { kind: 'card' };
  return { kind: 'pill', label: notes ? PROMPT_WORDS.turnOn : PROMPT_WORDS.add, action: 'allow' };
}

// ---- the settings card's row ----

export interface AiRowFacts extends AiFacts {
  /** The store's progress for the `ai` subsystem. */
  progress: AiWork | undefined;
}

export interface AiRow {
  /** Stored `granted` is On; `declined` and unanswered are Off. */
  value: 'on' | 'off';
  /** Generation is running, so "Off" means "stop". */
  writing: boolean;
}

/** The "AI notes" row for the open map, or null when AI cannot apply to it and the row is hidden. */
export function aiRow(facts: AiRowFacts): AiRow | null {
  if (!aiCanRun(facts)) return null;
  const on = facts.consent === 'granted';
  return { value: on ? 'on' : 'off', writing: on && inFlight(facts.progress) };
}
