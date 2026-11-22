// Consent (PLAN.md §11.4): AI is the only path by which code excerpts leave the machine, so the app
// asks once per repository and remembers the answer in this browser. Pure: the storage is passed in
// (default `localStorage`), so this runs in tests and does nothing harmful where there is none.
import type { Config } from '../../config';
import type { Annotation, RepoMeta } from '../../model/types';

export type Consent = 'granted' | 'declined';

/** One JSON object, repo id → answer. */
export const CONSENT_KEY = 'starmap.ai.consent';

export type ConsentStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): ConsentStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage is blocked for this origin
  }
}

function load(storage: ConsentStorage | null): Record<string, Consent> {
  const out: Record<string, Consent> = {};
  try {
    const saved: unknown = JSON.parse(storage?.getItem(CONSENT_KEY) ?? 'null');
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return out;
    for (const [id, answer] of Object.entries(saved)) {
      if (answer === 'granted' || answer === 'declined') out[id] = answer;
    }
  } catch {
    // no storage, or something else wrote the key: nobody has answered
  }
  return out;
}

function save(storage: ConsentStorage | null, answers: Record<string, Consent>): void {
  try { storage?.setItem(CONSENT_KEY, JSON.stringify(answers)); } catch { /* private mode: the answer lasts for this visit only where the caller keeps it */ }
}

/** The viewer's answer for this repository (`RepoMeta.id`), or null when they have not been asked. */
export function getConsent(repoId: string, storage: ConsentStorage | null = defaultStorage()): Consent | null {
  const answers = load(storage);
  return Object.hasOwn(answers, repoId) ? answers[repoId] : null;
}

export function setConsent(repoId: string, consent: Consent, storage: ConsentStorage | null = defaultStorage()): void {
  const answers = load(storage);
  answers[repoId] = consent;
  save(storage, answers);
}

/** Forget the answer, so the viewer is asked again. This is how "Not now" is reversed. */
export function resetConsent(repoId: string, storage: ConsentStorage | null = defaultStorage()): void {
  const answers = load(storage);
  if (!Object.hasOwn(answers, repoId)) return;
  delete answers[repoId];
  save(storage, answers);
}

/**
 * True when the model carries AI annotations and the digest hash they were generated from. The main
 * thread cannot rebuild the digest (the facts live in the coordinator worker), so "for the current
 * digest" is decided there: `generateAnnotations` replaces a set whose hash no longer matches.
 */
export function hasStoredAnnotations(meta: Pick<RepoMeta, 'digestHash'> | null, annotations: readonly Annotation[]): boolean {
  return Boolean(meta?.digestHash) && annotations.length > 0;
}

/** May AI run at all on this map? Not when it is turned off, and never on a demo (PLAN.md §11.4). */
export function aiAllowed(config: Config, meta: Pick<RepoMeta, 'source'> | null): boolean {
  return config.ai.enabled && meta !== null && meta.source !== 'demo';
}

/**
 * Whether to show the consent prompt: only when AI is enabled, the map is not a demo, nothing is
 * stored yet, and the viewer has not answered for this repository.
 */
export function shouldAsk(args: {
  config: Config;
  meta: Pick<RepoMeta, 'source' | 'digestHash'> | null;
  annotations: readonly Annotation[];
  consent: Consent | null;
}): boolean {
  return aiAllowed(args.config, args.meta) && !hasStoredAnnotations(args.meta, args.annotations) && args.consent === null;
}
