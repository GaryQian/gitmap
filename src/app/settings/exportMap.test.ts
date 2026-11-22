// The pure parts of the package export: what the manifest says about the AI work, which detail
// cards are still to be written, and the line for config.json.
import { describe, expect, it } from 'vitest';
import type { Annotation, Poi, PoiDetail } from '../../model/types';
import { DETAIL_KEYS, aiCompleteness, configLine, finishAi, incompleteNotes, missingDetails } from './exportMap';

const ready: PoiDetail = { status: 'ready', markdown: 'x' };
const allReady = Object.fromEntries(DETAIL_KEYS.map((q) => [q, ready]));

const poi = (id: string, details: Record<string, PoiDetail> = {}): Poi =>
  ({ type: 'poi', id, parent: 'u:src/a.ts', label: 'A', summary: 's', kind: 'core', evidence: 'e', details });
const summary: Annotation = { type: 'summary', id: 'summary:1', parent: 'c:1', text: 'x' };
const tour: Annotation = { type: 'tour', id: 'tour', steps: [{ parent: 'u:src/a.ts', frame: 'file', text: 't', highlights: [] }] };

describe('detail cards still to write', () => {
  it('lists every question of every point that has no stored answer', () => {
    const annotations = [
      summary,
      poi('p1', { ...allReady }),
      poi('p2', { role: ready, users: { status: 'error' }, entry: { status: 'loading' } }),
    ];
    expect(missingDetails(annotations)).toEqual([
      { poiId: 'p2', question: 'users' },
      { poiId: 'p2', question: 'entry' },
      { poiId: 'p2', question: 'walkthrough' },
    ]);
    expect(missingDetails([summary, tour])).toEqual([]);
  });
});

describe('manifest.ai', () => {
  it('is none without annotations, complete with everything, partial between', () => {
    expect(aiCompleteness([])).toBe('none');
    expect(aiCompleteness([summary, poi('p1', { ...allReady }), tour])).toBe('complete');
    // a detail card is missing
    expect(aiCompleteness([summary, poi('p1', { role: ready }), tour])).toBe('partial');
    // no tour, no points of interest, no summaries
    expect(aiCompleteness([summary, poi('p1', { ...allReady })])).toBe('partial');
    expect(aiCompleteness([summary, tour])).toBe('partial');
    expect(aiCompleteness([poi('p1', { ...allReady }), tour])).toBe('partial');
    expect(aiCompleteness([summary, poi('p1', { ...allReady }), { type: 'tour', id: 'tour', steps: [] }])).toBe('partial');
  });
});

describe('the line for config.json', () => {
  it('names the package under /demo and gives the source without its scheme', () => {
    const line = configLine('react', 'react.starmap.zip', 'https://github.com/facebook/react');
    expect(line).toBe('{ "name": "react", "file": "/demo/react.starmap.zip", "location": "github.com/facebook/react" }');
    expect(JSON.parse(line)).toEqual({ name: 'react', file: '/demo/react.starmap.zip', location: 'github.com/facebook/react' });
  });

  it('leaves the location out when the map has no remote, and stays valid JSON', () => {
    expect(configLine('notes', 'notes.starmap.zip', '')).toBe('{ "name": "notes", "file": "/demo/notes.starmap.zip" }');
    expect(JSON.parse(configLine('my "repo"', 'my-repo.starmap.zip', 'https://example.com/a/b/')))
      .toEqual({ name: 'my "repo"', file: '/demo/my-repo.starmap.zip', location: 'example.com/a/b' });
  });
});

describe('an unfinished map', () => {
  it('is named in the confirmation', () => {
    expect(incompleteNotes({ structure: 'full' })).toEqual([]);
    expect(incompleteNotes({ structure: 'full', history: { reachedOid: null, commitsWalked: 9, complete: true } })).toEqual([]);
    expect(incompleteNotes({ structure: 'imports-only', history: { reachedOid: 'a', commitsWalked: 9, complete: false } })).toEqual([
      'The refined structure has not been applied.',
      'History was loaded only up to its cap.',
    ]);
  });
});

describe('finishing the AI work', () => {
  it('generates first, then asks for each missing card, and reports a failure without stopping', async () => {
    const annotations: Annotation[] = [summary, poi('p1', { role: ready }), tour];
    const calls: string[] = [];
    const progress: string[] = [];
    const failure = await finishAi({
      ai: {
        start: async () => { calls.push('start'); },
        requestDetail: async (poiId, question) => {
          calls.push(`${poiId} ${question}`);
          return question === 'users' ? { failure: { code: 'refused', message: 'The model declined.' } } : undefined;
        },
      },
      annotations: () => annotations,
      allowed: () => true,
      onProgress: (done, total) => progress.push(`${done}/${total}`),
      signal: new AbortController().signal,
    });
    expect(calls[0]).toBe('start');
    expect(calls.slice(1).sort()).toEqual(['p1 entry', 'p1 users', 'p1 walkthrough']);
    expect(failure).toBe('The model declined.');
    // one card was stored already, two more were written, one failed
    expect(progress).toEqual(['0/0', '1/4', '2/4', '3/4']);
  });

  it('asks for nothing once the viewer has turned AI off', async () => {
    const calls: string[] = [];
    const failure = await finishAi({
      ai: { start: async () => { calls.push('start'); }, requestDetail: async () => { calls.push('detail'); } },
      annotations: () => [poi('p1')],
      allowed: () => false,
      signal: new AbortController().signal,
    });
    expect(calls).toEqual([]);
    expect(failure).toBeNull();
  });
});
