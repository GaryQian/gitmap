import { describe, expect, it } from 'vitest';
import type { Annotation, NodeRef } from '../../model/types';
import { cardContent, cardOwner, inFlight, pinnedCity, placeCard, summaryFor, titleFor, type Rect } from './logic';
import { SUMMARY_UI } from './tunables';

const summary = (id: string, parent: NodeRef, text: string, label?: string): Annotation =>
  ({ type: 'summary', id, parent, text, label });

describe('choosing the summary of a node', () => {
  const annotations: Annotation[] = [
    summary('s1', 'c:api', 'An older summary.'),
    { type: 'poi', id: 'p1', parent: 'u:api/server.ts', label: 'Entry point', kind: 'core', summary: 'Not a city summary.', evidence: '', details: {} } as unknown as Annotation,
    { type: 'tour', id: 't1', steps: [] },
    summary('s2', 'c:web', 'The web client.'),
    summary('s3', 'c:api', 'Handles requests.', 'Request handling'),
    summary('s4', 'd:api/routes', 'Routes of the API.'),
  ];

  it('takes the last summary written for that ref and ignores other annotations', () => {
    expect(summaryFor(annotations, 'c:api')?.id).toBe('s3');
    expect(summaryFor(annotations, 'c:web')?.id).toBe('s2');
    expect(summaryFor(annotations, 'u:api/server.ts')).toBeNull();
    expect(summaryFor(annotations, 'c:missing')).toBeNull();
  });

  it('finds a district summary the same way, should one ever exist', () => {
    expect(summaryFor(annotations, 'd:api/routes')?.id).toBe('s4');
    expect(cardContent(annotations, 'd:api/routes', 'routes', false)).toEqual({ kind: 'summary', title: null, text: 'Routes of the API.' });
  });

  it('says what the card shows: the summary, a waiting line, or nothing', () => {
    expect(cardContent(annotations, 'c:api', 'api', false)).toEqual({ kind: 'summary', title: 'Request handling', text: 'Handles requests.' });
    // no summary: a line while one is being written, otherwise no card at all
    expect(cardContent(annotations, 'c:tools', 'tools', true)).toEqual({ kind: 'pending' });
    expect(cardContent(annotations, 'c:tools', 'tools', false)).toBeNull();
    // districts are not summarised, so none is ever on its way
    expect(cardContent(annotations, 'd:tools/lint', 'lint', true)).toBeNull();
    // an empty summary is no summary
    expect(cardContent([summary('s5', 'c:tools', '  ')], 'c:tools', 'tools', false)).toBeNull();
  });

  it('knows when generation is under way', () => {
    expect(inFlight(undefined)).toBe(false);
    expect(inFlight({ done: 0, total: 0 })).toBe(false);
    expect(inFlight({ done: 2, total: 6 })).toBe(true);
    expect(inFlight({ done: 6, total: 6 })).toBe(false);
  });
});

describe('the title of the card', () => {
  it('is the label', () => {
    expect(titleFor('Request handling', 'api')).toBe('Request handling');
  });

  it('is dropped when the label is missing or merely repeats the name on the pill', () => {
    expect(titleFor(undefined, 'api')).toBeNull();
    expect(titleFor('  ', 'api')).toBeNull();
    expect(titleFor('API', 'api')).toBeNull();
    expect(titleFor('Request handling', 'request-handling')).toBeNull();
    expect(titleFor('Request handling.', ' Request  Handling')).toBeNull();
  });
});

describe('whose card is showing', () => {
  const all = () => true;

  it('pins the most recently selected city, and nothing for files or districts', () => {
    expect(pinnedCity([])).toBeNull();
    expect(pinnedCity(['u:api/server.ts', 'f:api/server.ts', 'd:api/routes'])).toBeNull();
    expect(pinnedCity(['c:api'])).toBe('c:api');
    expect(pinnedCity(['c:api', 'c:web'])).toBe('c:web');
    // a file selected after the city does not unpin it
    expect(pinnedCity(['c:api', 'c:web', 'u:web/app.ts'])).toBe('c:web');
  });

  it('is the hovered or focused pill when nothing is pinned, and nothing when nothing is pointed at', () => {
    expect(cardOwner('c:api', null, all)).toEqual({ ref: 'c:api', pinned: false });
    expect(cardOwner(null, null, all)).toBeNull();
  });

  it('is the pinned city while no other pill is hovered or focused', () => {
    expect(cardOwner(null, 'c:api', all)).toEqual({ ref: 'c:api', pinned: true });
    // on the pinned pill itself, hovering changes nothing
    expect(cardOwner('c:api', 'c:api', all)).toEqual({ ref: 'c:api', pinned: true });
  });

  it('lets hover or focus on another pill win for as long as it lasts', () => {
    expect(cardOwner('c:web', 'c:api', all)).toEqual({ ref: 'c:web', pinned: false });
    expect(cardOwner(null, 'c:api', all)).toEqual({ ref: 'c:api', pinned: true });
  });

  it('keeps the pinned card when the other pill has nothing to say', () => {
    const onlyApi = (ref: NodeRef) => ref === 'c:api';
    expect(cardOwner('c:web', 'c:api', onlyApi)).toEqual({ ref: 'c:api', pinned: true });
    // with nothing pinned the hovered pill is still the owner; an empty card simply draws nothing
    expect(cardOwner('c:web', null, onlyApi)).toEqual({ ref: 'c:web', pinned: false });
  });
});

describe('placing the card', () => {
  const opts = { gap: SUMMARY_UI.gapPx, margin: SUMMARY_UI.marginPx };
  const view = { width: 1000, height: 700 };
  const card = { width: 300, height: 120 };
  const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  it('goes centred below the pill', () => {
    const pill = { x: 440, y: 200, width: 120, height: 32 };
    const spot = placeCard(pill, card, view, opts);
    expect(spot.side).toBe('below');
    expect(spot.x + card.width / 2).toBe(pill.x + pill.width / 2);
    expect(spot.y).toBe(pill.y + pill.height + opts.gap);
  });

  it('goes above when there is no room below', () => {
    const pill = { x: 440, y: 620, width: 120, height: 32 };
    const spot = placeCard(pill, card, view, opts);
    expect(spot.side).toBe('above');
    expect(spot.y + card.height).toBe(pill.y - opts.gap);
  });

  it('stays inside the view sideways, at either edge', () => {
    const left = placeCard({ x: 6, y: 200, width: 90, height: 32 }, card, view, opts);
    expect(left.x).toBe(opts.margin);
    const right = placeCard({ x: 900, y: 200, width: 94, height: 32 }, card, view, opts);
    expect(right.x + card.width).toBe(view.width - opts.margin);
  });

  it('goes above when something is in the way below, and below when both sides are taken', () => {
    const pill = { x: 440, y: 300, width: 120, height: 32 };
    const legend = { x: 400, y: 360, width: 300, height: 300 };
    expect(placeCard(pill, card, view, opts, [legend]).side).toBe('above');
    const banner = { x: 0, y: 200, width: 1000, height: 60 };
    expect(placeCard(pill, card, view, opts, [legend, banner]).side).toBe('below');
  });

  it('never covers its pill, wherever the pill is', () => {
    for (const short of [view, { width: 320, height: 150 }]) {
      for (let y = 0; y <= short.height - 32; y += 13) {
        for (const x of [0, 100, short.width - 120]) {
          const pill = { x, y, width: 120, height: 32 };
          const spot = placeCard(pill, card, short, opts);
          expect(overlap({ ...spot, ...card }, pill)).toBe(false);
        }
      }
    }
  });
});
