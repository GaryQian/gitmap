// The AI chrome's rules, without a DOM or a store: what the prompt and the settings row show, and
// what turning AI off and on does to the stored answer and to the controller.
import { describe, expect, it } from 'vitest';
import { getConsent } from '../../ai';
import type { AiErrorInfo, Consent, ConsentStorage } from '../../ai';
import { withConfig } from '../../config';
import type { Annotation } from '../../model/types';
import type { AiController, AiRunOutcome } from './controller';
import { createAiFlow, type AiMap } from './flow';
import { PROMPT_WORDS, aiPrompt, aiRow, type AiPromptFacts, type AiRowFacts } from './rules';

const on = withConfig({ ai: { enabled: true } });
const off = withConfig({ ai: { enabled: false } });
const git = { id: 'repo-a', source: 'git' as const };
const withNotes = { ...git, digestHash: 'abc' };
const summary: Annotation = { type: 'summary', id: 'summary:1', parent: 'c:1', text: 'x' };

function memoryStorage(): ConsentStorage {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

/** A controller that records what it is asked. `start` stays out until `finish` is called. */
function fakeController(outcome: AiRunOutcome | void = undefined) {
  const calls: string[] = [];
  const open: ((v: AiRunOutcome | void) => void)[] = [];
  const controller: AiController = {
    available: true,
    start: () => { calls.push('start'); return new Promise((resolve) => { open.push(resolve); }); },
    requestDetail: async (poiId, question) => { calls.push(`detail ${poiId} ${question}`); },
    cancel: () => { calls.push('cancel'); },
  };
  const finish = async () => {
    for (const resolve of open.splice(0)) resolve(outcome);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { controller, calls, finish };
}

describe('ai prompt at the bottom centre', () => {
  const facts = (over: Partial<AiPromptFacts>): AiPromptFacts => ({
    config: on, meta: git, available: true, consent: null, annotations: [], busy: false, ...over,
  });
  const allow = (label: string) => ({ kind: 'pill', label, action: 'allow' });

  it('always offers AI while it is not on: the card first, then a pill', () => {
    // unanswered and no notes: the full card
    expect(aiPrompt(facts({}))).toEqual({ kind: 'card' });
    // "Not now" collapses it to a pill instead of removing the prompt
    expect(aiPrompt(facts({ consent: 'declined' }))).toEqual(allow(PROMPT_WORDS.add));
    // notes from an earlier visit are on the map: no card, but still a way in
    expect(aiPrompt(facts({ meta: withNotes, annotations: [summary] }))).toEqual(allow(PROMPT_WORDS.turnOn));
    expect(aiPrompt(facts({ meta: withNotes, annotations: [summary], consent: 'declined' }))).toEqual(allow(PROMPT_WORDS.turnOn));
    // declined stays a pill whatever a run that is winding down still reports
    expect(aiPrompt(facts({ consent: 'declined', busy: true })).kind).toBe('pill');
    // annotations without a digest hash were not written here: they do not count as notes
    expect(aiPrompt(facts({ annotations: [summary] }))).toEqual({ kind: 'card' });
  });

  it('offers to write again when AI is on but the map has no notes, and steps aside otherwise', () => {
    const granted = { consent: 'granted' as const };
    expect(aiPrompt(facts({ ...granted }))).toEqual({ kind: 'pill', label: PROMPT_WORDS.write, action: 'retry' });
    expect(aiPrompt(facts({ ...granted, busy: true }))).toEqual({ kind: 'none' });
    expect(aiPrompt(facts({ ...granted, meta: withNotes, annotations: [summary] }))).toEqual({ kind: 'none' });
    expect(aiPrompt(facts({ ...granted, meta: withNotes, annotations: [summary], busy: true }))).toEqual({ kind: 'none' });
    expect(new Set(Object.values(PROMPT_WORDS)).size).toBe(3); // one wording per case
  });

  it('shows nothing where AI cannot run', () => {
    for (const consent of [null, 'granted', 'declined'] as const) {
      expect(aiPrompt(facts({ consent, config: off })), String(consent)).toEqual({ kind: 'none' });
      expect(aiPrompt(facts({ consent, meta: { id: 'demo', source: 'demo' } })), String(consent)).toEqual({ kind: 'none' });
      expect(aiPrompt(facts({ consent, available: false })), String(consent)).toEqual({ kind: 'none' });
      expect(aiPrompt(facts({ consent, meta: null })), String(consent)).toEqual({ kind: 'none' });
    }
  });
});

describe('ai notes row of the settings card', () => {
  const facts = (over: Partial<AiRowFacts>): AiRowFacts => ({
    config: on, meta: git, available: true, consent: null, progress: undefined, ...over,
  });

  it('is hidden when AI cannot apply to the map', () => {
    expect(aiRow(facts({ config: off }))).toBeNull();
    expect(aiRow(facts({ meta: { id: 'demo', source: 'demo' }, consent: 'granted' }))).toBeNull();
    expect(aiRow(facts({ available: false, consent: 'granted' }))).toBeNull();
    expect(aiRow(facts({ meta: null }))).toBeNull();
  });

  it('shows the stored answer: granted is On, declined and unanswered are Off', () => {
    expect(aiRow(facts({ consent: 'granted' }))).toEqual({ value: 'on', writing: false });
    expect(aiRow(facts({ consent: 'declined' }))).toEqual({ value: 'off', writing: false });
    expect(aiRow(facts({ consent: null }))).toEqual({ value: 'off', writing: false });
  });

  it('says that notes are being written only while AI is on and the run is unfinished', () => {
    const half = { done: 2, total: 5 };
    expect(aiRow(facts({ consent: 'granted', progress: half }))?.writing).toBe(true);
    expect(aiRow(facts({ consent: 'granted', progress: { done: 5, total: 5 } }))?.writing).toBe(false);
    expect(aiRow(facts({ consent: 'granted', progress: { done: 0, total: 0 } }))?.writing).toBe(false);
    // turned off: the run is being stopped, whatever its last report said
    expect(aiRow(facts({ consent: 'declined', progress: half }))?.writing).toBe(false);
  });
});

describe('turning AI off and on for a repository', () => {
  function setup(first: Consent | null = null, outcome: AiRunOutcome | void = undefined) {
    const storage = memoryStorage();
    const fake = fakeController(outcome);
    const failures: unknown[] = [];
    let changes = 0;
    const flow = createAiFlow({ storage, onChange: () => { changes++; }, onFailure: (_map, failure) => failures.push(failure) });
    const map: AiMap = { key: {}, repoId: 'repo-a', controller: fake.controller };
    if (first) flow.answer(map.repoId, first, map);
    return { ...fake, flow, map, storage, failures, changes: () => changes, stored: () => getConsent('repo-a', storage) };
  }

  it('on: stores granted and starts generation once', () => {
    const { flow, map, calls, stored } = setup();
    flow.turnOn(map);
    expect(stored()).toBe('granted');
    expect(flow.consent(map.repoId)).toBe('granted');
    expect(calls).toEqual(['start']);
    // the mount's own start for the same map, and a second "On", add nothing
    flow.start(map);
    flow.turnOn(map);
    expect(calls).toEqual(['start']);
  });

  it('off: stores declined, cancels once, and lets nothing more through until it is on again', async () => {
    const { flow, map, calls, stored, finish } = setup();
    flow.turnOn(map);
    flow.detail(map, 'poi:1', 'role');
    await finish();
    expect(calls).toEqual(['start', 'detail poi:1 role']);

    flow.turnOff(map);
    expect(stored()).toBe('declined');
    expect(calls.filter((c) => c === 'cancel')).toHaveLength(1);
    flow.turnOff(map); // already off: nothing to stop
    expect(calls.filter((c) => c === 'cancel')).toHaveLength(1);

    // no request for this repository while it is off
    const before = calls.length;
    flow.start(map);
    flow.retry(map);
    flow.detail(map, 'poi:1', 'users');
    await finish();
    expect(calls).toHaveLength(before);

    // on again: generation is asked for again (a stored set for the digest makes no request there)
    flow.turnOn(map);
    expect(stored()).toBe('granted');
    expect(calls.slice(before)).toEqual(['start']);
  });

  it('"Not now" before anything ran stores declined without a cancel, and another repository is untouched', () => {
    const { flow, map, calls, storage } = setup();
    flow.answer('repo-b', 'granted');
    flow.turnOff(map);
    expect(getConsent('repo-a', storage)).toBe('declined');
    expect(getConsent('repo-b', storage)).toBe('granted');
    expect(calls).toEqual([]);
    // an answer for another repository does not stop the open map
    flow.turnOn(map);
    flow.answer('repo-b', 'declined', map);
    expect(calls).toEqual(['start']);
  });

  it('cancels work that shows up while AI is off: a start that was still waiting when it was turned off', () => {
    const { flow, map, calls } = setup('granted');
    flow.start(map);
    flow.turnOff(map);
    expect(calls).toEqual(['start', 'cancel']);
    flow.progressed(map, { done: 0, total: 6 }); // the run began after all
    expect(calls).toEqual(['start', 'cancel', 'cancel']);
    flow.progressed(map, { done: 6, total: 6 }); // and has ended: nothing to stop
    expect(calls).toHaveLength(3);

    // while on, progress is only progress
    flow.turnOn(map);
    flow.progressed(map, { done: 1, total: 6 });
    expect(calls.filter((c) => c === 'cancel')).toHaveLength(2);
  });

  it('knows when a run is out, reports its failure, and can be asked again afterwards', async () => {
    const reason: AiErrorInfo = { code: 'unavailable', message: 'AI notes are written from a fresh parse.' };
    const { flow, map, calls, failures, finish, changes } = setup(null, { failure: reason });
    expect(flow.started(map.key)).toBe(false);
    flow.turnOn(map);
    expect(flow.started(map.key)).toBe(true);
    expect(flow.running(map.key)).toBe(true);
    flow.retry(map); // not while the first is out
    expect(calls).toEqual(['start']);

    const seen = changes();
    await finish();
    expect(flow.running(map.key)).toBe(false);
    expect(changes()).toBeGreaterThan(seen); // the chrome is told, so the pill can come back
    expect(failures).toEqual([reason]);

    flow.retry(map);
    expect(calls).toEqual(['start', 'start']);
    // a failure that arrives after AI was turned off is not shown
    flow.turnOff(map);
    await finish();
    expect(failures).toEqual([reason]);
  });

  it('keeps the answer for this visit when the browser stores nothing', () => {
    const fake = fakeController();
    const flow = createAiFlow({ storage: null });
    const map: AiMap = { key: {}, repoId: 'repo-a', controller: fake.controller };
    expect(flow.consent('repo-a')).toBeNull();
    flow.turnOn(map);
    expect(flow.consent('repo-a')).toBe('granted');
    flow.turnOff(map);
    expect(flow.consent('repo-a')).toBe('declined');
    expect(fake.calls).toEqual(['start', 'cancel']);
  });
});
