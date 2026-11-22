import { describe, expect, it } from 'vitest';
import { LAYER, dismissTop, orderByRegion, registerDismissable, topDismissable } from './keys';

describe('Escape closes one layer per press', () => {
  it('closes the most recently opened first, one per press, and forgets what has closed', () => {
    const closed: string[] = [];
    const layer = (name: string, at?: number) => {
      const off = registerDismissable({ layer: at, close: () => { closed.push(name); off(); } });
      return off;
    };
    layer('settings card');
    layer('detail card');
    expect(dismissTop()).toBe(true);
    expect(closed).toEqual(['detail card']);
    expect(dismissTop()).toBe(true);
    expect(closed).toEqual(['detail card', 'settings card']);
    expect(dismissTop()).toBe(false);
    expect(closed).toHaveLength(2);
  });

  it('closes a list before a card, the tour before the sidebar, and the selection last, whenever each opened', () => {
    const closed: string[] = [];
    const offs = (['list', 'selection', 'card', 'sidebar', 'tour'] as const).map((name) => {
      const off = registerDismissable({ layer: LAYER[name], close: () => { closed.push(name); off(); } });
      return off;
    });
    while (dismissTop()) { /* one layer each time */ }
    expect(closed).toEqual(['list', 'card', 'tour', 'sidebar', 'selection']);
    offs.forEach((off) => off());
  });

  it('leaves a text field to the layer that owns it', () => {
    const field = {} as EventTarget;
    const closed: string[] = [];
    const offSelection = registerDismissable({ layer: LAYER.selection, close: () => closed.push('selection') });
    expect(topDismissable(field)).toBeNull(); // typing somewhere that no layer owns: Escape does nothing
    const offSearch = registerDismissable({ layer: LAYER.list, owns: (f) => f === field, close: () => closed.push('search') });
    dismissTop(field);
    expect(closed).toEqual(['search']);
    offSearch();
    offSelection();
    expect(topDismissable()).toBeNull();
  });
});

describe('Tab order', () => {
  it('visits the regions in reading order, keeping document order within a region', () => {
    // document order: the scene first, then the rows of chrome, then the sidebar
    const stops = ['scene:pill', 'topLeft:title', 'topLeft:info', 'topCenter:search', 'topRight:gear', 'bottomLeft:reset', 'bottomRight:legend', 'rightEdge:close'];
    expect(orderByRegion(stops, (s) => s.split(':')[0]!)).toEqual([
      'topLeft:title', 'topLeft:info', 'topCenter:search', 'topRight:gear', 'scene:pill', 'rightEdge:close', 'bottomLeft:reset', 'bottomRight:legend',
    ]);
  });
});
