// The scheduling rules, checked on the pure core with scripted workers: the test decides when a
// worker takes a task (take) and when it is done (finish).
import { describe, expect, it } from 'vitest';
import { LANES, type Lane } from '../contracts/compute';
import { Scheduler } from './scheduler';

/** Start tasks on every free worker; returns the names started, in order. */
function drain(s: Scheduler<string>): string[] {
  const started: string[] = [];
  for (let a = s.take(); a; a = s.take()) started.push(a.task.payload);
  return started;
}

/** Queue `count` tasks named `<lane><n>` in a lane. */
function fill(s: Scheduler<string>, lane: Lane, count: number, group?: string): void {
  for (let i = 0; i < count; i++) s.enqueue(`${lane}${i}`, lane, group);
}

describe('Scheduler', () => {
  it('always serves the higher lane first', () => {
    const s = new Scheduler<string>({ workers: 1, parseFloorWorkers: 0 });
    for (const lane of [...LANES].reverse()) { s.enqueue(`${lane}-a`, lane); s.enqueue(`${lane}-b`, lane); }
    const order: string[] = [];
    for (let a = s.take(); a; a = s.take()) { order.push(a.task.payload); s.finish(a.worker); }
    expect(order).toEqual(LANES.flatMap((lane) => [`${lane}-a`, `${lane}-b`]));
    expect(s.stats().completed).toBe(order.length);
  });

  it('is work-conserving: a free worker takes lower-lane work', () => {
    const s = new Scheduler<string>({ workers: 3, parseFloorWorkers: 1 });
    s.enqueue('click', 'interactive');
    s.enqueue('snapshot', 'housekeeping');
    s.enqueue('history', 'otherOverlays');
    expect(drain(s)).toEqual(['click', 'history', 'snapshot']);
    expect(s.stats().busy).toBe(3);
  });

  it('keeps the parse floor while a selected overlay has work', () => {
    const floor = 1, workers = 3;
    const s = new Scheduler<string>({ workers, parseFloorWorkers: floor });
    fill(s, 'selectedOverlay', 20);
    fill(s, 'parse', 20);
    const running = new Map<number, string>();
    const start = () => { for (let a = s.take(); a; a = s.take()) running.set(a.worker, a.task.payload); };
    const onParse = () => [...running.values()].filter((n) => n.startsWith('parse')).length;
    start();
    expect(onParse()).toBe(floor);
    // Whichever worker finishes, parse keeps exactly its floor and the overlay gets the rest.
    for (let step = 0; step < 12; step++) {
      const worker = step % workers;
      s.finish(worker);
      running.delete(worker);
      start();
      expect(running.size).toBe(workers);
      expect(onParse()).toBe(floor);
    }
    // The interactive lane is not limited by the floor.
    fill(s, 'interactive', workers);
    for (let w = 0; w < workers; w++) { s.finish(w); running.delete(w); }
    start();
    expect([...running.values()].every((n) => n.startsWith('interactive'))).toBe(true);
  });

  it('moves a group between lanes, queued and future tasks alike', () => {
    const s = new Scheduler<string>({ workers: 1, parseFloorWorkers: 0 });
    s.enqueue('parse-1', 'parse');
    s.enqueue('walk-1', 'otherOverlays', 'history');
    s.enqueue('parse-2', 'parse');
    s.setGroupLane('history', 'selectedOverlay');
    s.enqueue('walk-2', 'otherOverlays', 'history');
    expect(s.stats().queued).toMatchObject({ selectedOverlay: 2, parse: 2, otherOverlays: 0 });
    const next = () => { const a = s.take()!; s.finish(a.worker); return a.task.payload; };
    expect([next(), next()]).toEqual(['walk-1', 'walk-2']);
    // Moved back, the group waits behind parse again.
    s.enqueue('walk-3', 'otherOverlays', 'history');
    s.setGroupLane('history', 'otherOverlays');
    expect([next(), next(), next()]).toEqual(['parse-1', 'parse-2', 'walk-3']);
  });

  it('parks lanes by level but always runs the interactive lane', () => {
    const s = new Scheduler<string>({ workers: 2, parseFloorWorkers: 1 });
    fill(s, 'parse', 2);
    fill(s, 'selectedOverlay', 1);
    s.setParkLevel(2);
    expect(drain(s)).toEqual([]);
    expect(s.stats().parked).toBe(2);
    s.enqueue('click', 'interactive');
    expect(drain(s)).toEqual(['click']);
    s.setParkLevel(1);
    expect(drain(s)).toEqual(['selectedOverlay0']);
    s.finish(0);
    expect(drain(s)).toEqual([]);
    expect(s.stats().queued.parse).toBe(2);
    s.setParkLevel(0);
    expect(drain(s)).toEqual(['parse0']);
  });

  it('cancels queued tasks and flags running ones', () => {
    const s = new Scheduler<string>({ workers: 1, parseFloorWorkers: 0 });
    s.enqueue('walk-1', 'otherOverlays', 'history');
    expect(drain(s)).toEqual(['walk-1']);
    s.enqueue('walk-2', 'otherOverlays', 'history');
    s.enqueue('parse-1', 'parse');
    expect(s.cancel('history').map((t) => t.payload).sort()).toEqual(['walk-1', 'walk-2']);
    expect(s.finish(0)?.cancelled).toBe(true);
    expect(s.stats().completed).toBe(0);
    expect(drain(s)).toEqual(['parse-1']);
  });
});
