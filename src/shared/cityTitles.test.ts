import { describe, expect, it } from 'vitest';
import { cityTitles } from './cityTitles';

const cities = [
  { id: 'render', name: 'render' },
  { id: 'base_api', name: 'base_api' },
  { id: 'g3doc', name: 'g3doc' },
  { id: 'api', name: 'api' },
  { id: 'tools', name: 'tools' },
];

describe('cityTitles', () => {
  it('keeps the derived name until AI notes give a title', () => {
    const names = cityTitles(cities, new Map());
    expect(names.get('render')).toEqual({ title: 'render', derived: 'render', titled: false });
  });

  it('names a city by its AI title', () => {
    const names = cityTitles(cities, new Map([['render', ' Map  rendering ']]));
    expect(names.get('render')).toEqual({ title: 'Map rendering', derived: 'render', titled: true });
    expect(names.get('tools')!.titled).toBe(false);
  });

  it('ignores an empty title and one that only repeats the derived name', () => {
    const names = cityTitles(cities, new Map([['render', '  '], ['api', 'API'], ['tools', undefined]]));
    for (const id of ['render', 'api', 'tools']) expect(names.get(id)!.titled).toBe(false);
  });

  it('tells apart cities that were given the same title', () => {
    const names = cityTitles(cities, new Map([['base_api', 'API documentation'], ['g3doc', 'api documentation'], ['render', 'Map rendering']]));
    expect(names.get('base_api')!.title).toBe('API documentation · base_api');
    expect(names.get('g3doc')!.title).toBe('api documentation · g3doc');
    expect(names.get('render')!.title).toBe('Map rendering');
  });

  it('tells a titled city apart from an untitled one whose derived name is that title', () => {
    const names = cityTitles(cities, new Map([['render', 'Tools']]));
    expect(names.get('render')!.title).toBe('Tools · render');
    expect(names.get('tools')!.title).toBe('tools');
  });
});
