// The inline pool end to end, with scripted tasks: each task blocks until the test releases it.
import { describe, expect, it } from 'vitest';
import { config, withConfig } from '../config';
import { defineTask, type ComputePool, type Lane } from '../contracts/compute';
import { memoryRepo } from '../testing/memory';
import { createInlinePool, poolSize } from './index';

/** A pool whose one task type, 'step', records its start and waits to be released by name. */
function scripted(size: number, cfg = config) {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const step = defineTask<string, string>({
    type: 'step',
    run: (name) => new Promise<string>((resolve) => { started.push(name); gates.set(name, () => resolve(name)); }),
  });
  const pool = createInlinePool({ config: cfg, tasks: [step], size });
  const settled: string[] = [];
  const submit = (name: string, lane: Lane, group?: string) =>
    pool.run<string, string>({ type: 'step', lane, input: name, group })
      .then((v) => { settled.push(v); return v; }, (e: Error) => { settled.push(`${name}: ${e.message}`); return null; });
  return { pool, started, settled, submit, release: (name: string) => gates.get(name)!() };
}

/** Let the pool dispatch (a microtask) and its simulated workers start (a turn of the event loop). */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('createInlinePool', () => {
  it('runs higher lanes first and lets a moved group jump the queue', async () => {
    const { pool, started, submit, release } = scripted(1, withConfig({ scheduler: { parseFloorWorkers: 0 } }));
    const all = [
      submit('snapshot', 'housekeeping'),
      submit('walk', 'otherOverlays', 'history'),
      submit('parse', 'parse'),
      submit('click', 'interactive'),
    ];
    await flush();
    expect(started).toEqual(['click']);
    pool.setGroupLane('history', 'selectedOverlay');
    for (const name of ['click', 'walk', 'parse', 'snapshot']) { release(name); await flush(); }
    await Promise.all(all);
    expect(started).toEqual(['click', 'walk', 'parse', 'snapshot']);
    expect(pool.stats()).toMatchObject({ busy: 0, completed: 4 });
  });

  it('holds parse at park level 1 but still runs interactive work', async () => {
    const { pool, started, submit, release } = scripted(2);
    pool.setParkLevel(1);
    const parse = submit('parse', 'parse');
    const click = submit('click', 'interactive');
    await flush();
    expect(started).toEqual(['click']);
    expect(pool.stats()).toMatchObject({ busy: 1, parked: 1 });
    release('click');
    expect(await click).toBe('click');
    await flush();
    expect(started).toEqual(['click']);
    pool.setParkLevel(0);
    await flush();
    release('parse');
    expect(await parse).toBe('parse');
  });

  it('rejects cancelled tasks, drops the result of a running one, and rejects after dispose', async () => {
    const { pool, started, settled, submit, release } = scripted(1);
    const running = submit('walk-1', 'otherOverlays', 'history');
    await flush();
    const queued = submit('walk-2', 'otherOverlays', 'history');
    const other = submit('parse', 'parse');
    pool.cancel('history');
    await Promise.all([running, queued]);
    expect([...settled].sort()).toEqual(['walk-1: cancelled', 'walk-2: cancelled']);
    release('walk-1');
    await flush();
    expect(started).toEqual(['walk-1', 'parse']);
    pool.dispose();
    await other;
    expect(settled[2]).toBe('parse: pool disposed');
    await expect(pool.run({ type: 'step', lane: 'interactive', input: 'late' })).rejects.toThrow('pool disposed');
  });

  it('opens the repo once per worker, gives each worker its own cache, and fails unknown tasks', async () => {
    let opens = 0;
    const visit = defineTask<void, string | null>({
      type: 'visit',
      async run(_input, ctx) {
        ctx.cache.set('visits', ((ctx.cache.get('visits') as number | undefined) ?? 0) + 1);
        return (await ctx.repo())?.name ?? null;
      },
    });
    const pool: ComputePool = createInlinePool({
      config, tasks: [visit], size: 1,
      openRepo: async (locator) => { opens++; return memoryRepo(locator.kind === 'memory' ? locator.name : '?', {}); },
    });
    const run = () => pool.run<string | null>({ type: 'visit', lane: 'parse', input: undefined });
    expect(await run()).toBeNull();
    await pool.setRepo({ kind: 'memory', name: 'demo', files: {} });
    expect(await Promise.all([run(), run(), run()])).toEqual(['demo', 'demo', 'demo']);
    expect(opens).toBe(1);
    await expect(pool.run({ type: 'nope', lane: 'parse', input: null })).rejects.toThrow('unknown task type: nope');
  });
});

describe('poolSize', () => {
  it('follows the cores, within the worker and memory caps', () => {
    const s = config.scheduler;
    const memoryCap = Math.max(1, Math.floor(s.memoryCapMB / s.memoryPerWorkerMB));
    expect(poolSize(config, 1)).toBe(1);
    expect(poolSize(config, 0)).toBe(1);
    let previous = 0;
    for (const cores of [1, 2, 4, 8, 16, 32, 64, 256]) {
      const n = poolSize(config, cores);
      expect(n).toBeGreaterThanOrEqual(previous);
      expect(n).toBeLessThanOrEqual(Math.min(s.maxWorkers, memoryCap, Math.max(1, Math.round(cores * s.workerShare))));
      expect(poolSize(config, cores, 0.25)).toBeLessThanOrEqual(n);
      previous = n;
    }
    expect(poolSize(config, 256)).toBe(Math.min(s.maxWorkers, memoryCap));
  });
});
