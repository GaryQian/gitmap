// The order of the landing page's pills: saved repos and demos together, by when each was last opened.
import { describe, expect, it } from 'vitest';
import type { DemoRepo } from '../../config';
import { demosOpened, markDemoOpened, orderPills } from './demos';
import type { SavedRepo } from './registry';

const saved = (id: string, name: string, lastOpened: number): SavedRepo => ({ id, name, remoteUrl: `github.com/x/${name}`, lastOpened });
const demos: DemoRepo[] = [
  { name: 'react', file: '/demo/react.starmap.zip', location: 'github.com/facebook/react' },
  { name: 'starmap', file: '/demo/starmap.starmap.zip' },
  { name: 'flutter', file: 'https://cdn.example/flutter.starmap.zip' },
];
const keys = (items: ReturnType<typeof orderPills>): string[] => items.map((i) => i.key);

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
}

describe('landing page pills', () => {
  it('sorts demos in with the saved repos, newest first, and puts unopened demos last in config order', () => {
    const list = orderPills([saved('a', 'alpha', 300), saved('b', 'beta', 100)], demos, { flutter: 200 });
    expect(keys(list)).toEqual(['saved:a', 'demo:flutter', 'saved:b', 'demo:react', 'demo:starmap']);
  });

  it('lists a saved repo and a demo of the same name as two pills', () => {
    const list = orderPills([saved('github.com/facebook/react', 'react', 100)], demos, { react: 500 });
    expect(keys(list)).toEqual(['demo:react', 'saved:github.com/facebook/react', 'demo:starmap', 'demo:flutter']);
    expect(list.filter((i) => i.repo.name === 'react').map((i) => i.kind)).toEqual(['demo', 'saved']);
  });

  it('shows only demos, in config order, on a first visit', () => {
    expect(keys(orderPills([], demos, {}))).toEqual(['demo:react', 'demo:starmap', 'demo:flutter']);
  });

  it('remembers when a demo was opened, and reads nothing from a damaged or missing store', () => {
    const storage = memoryStorage();
    expect(demosOpened(storage)).toEqual({});
    markDemoOpened('react', 10, storage);
    markDemoOpened('starmap', 20, storage);
    markDemoOpened('react', 30, storage);
    expect(demosOpened(storage)).toEqual({ react: 30, starmap: 20 });
    expect(demosOpened({ getItem: () => '{"react":"yesterday","x":[1]}', setItem() {} })).toEqual({});
    expect(demosOpened({ getItem: () => 'not json', setItem() {} })).toEqual({});
    expect(demosOpened(null)).toEqual({});
    expect(() => markDemoOpened('react', 1, null)).not.toThrow();
  });
});
