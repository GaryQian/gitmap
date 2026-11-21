// The scheduling rules of the compute pool (PLAN.md §3.1) as a pure state machine: no Workers, no
// timers, no promises. A driver (pool.ts) feeds it tasks, asks which task a free worker takes, and
// reports when a worker is done.
import { LANES, type Lane, type PoolStats } from '../contracts/compute';

export type ParkLevel = 0 | 1 | 2;

export interface SchedulerOptions {
  /** Number of worker slots. */
  workers: number;
  /** config.scheduler.parseFloorWorkers. */
  parseFloorWorkers: number;
}

export interface ScheduledTask<T> {
  /** Submission order; queues are kept in this order. */
  readonly id: number;
  readonly payload: T;
  readonly group: string | undefined;
  /** The lane the task is queued in or, once running, was taken from. */
  lane: Lane;
  /** Set by cancel() on a running task: its result is to be dropped. */
  cancelled: boolean;
}

export interface Assignment<T> { worker: number; task: ScheduledTask<T> }

const SELECTED = LANES.indexOf('selectedOverlay');
const PARSE = LANES.indexOf('parse');
/** Per park level, the first lane (in priority order) that may not start tasks. */
const HELD_FROM: Record<ParkLevel, number> = { 0: LANES.length, 1: PARSE, 2: SELECTED };

/** A queue ordered by task id, with cheap removal from the front. */
class Fifo<T> {
  private items: ScheduledTask<T>[] = [];
  private head = 0;
  get length(): number { return this.items.length - this.head; }
  push(task: ScheduledTask<T>): void { this.items.push(task); }
  shift(): ScheduledTask<T> | undefined {
    if (this.head >= this.items.length) return undefined;
    const task = this.items[this.head++];
    if (this.head >= 1024 && this.head * 2 >= this.items.length) { this.items = this.items.slice(this.head); this.head = 0; }
    return task;
  }
  /** Remove and return every task that matches. */
  extract(match: (task: ScheduledTask<T>) => boolean): ScheduledTask<T>[] {
    const out: ScheduledTask<T>[] = [];
    const keep: ScheduledTask<T>[] = [];
    for (let i = this.head; i < this.items.length; i++) (match(this.items[i]) ? out : keep).push(this.items[i]);
    if (out.length) { this.items = keep; this.head = 0; }
    return out;
  }
  /** Add tasks that were submitted earlier, keeping submission order. */
  merge(added: ScheduledTask<T>[]): void {
    this.items = this.items.slice(this.head).concat(added).sort((a, b) => a.id - b.id);
    this.head = 0;
  }
}

interface Slot<T> { task: ScheduledTask<T> | null; retired: boolean }

export class Scheduler<T> {
  private readonly queues: Fifo<T>[] = LANES.map(() => new Fifo<T>());
  private readonly slots: Slot<T>[];
  private readonly groupLane = new Map<string, Lane>();
  private readonly configuredFloor: number;
  private parkLevel: ParkLevel = 0;
  private nextId = 1;
  private completed = 0;
  /** Only used when the floor cannot be held (see parseIsOwed). */
  private parseTurn = false;

  constructor(opts: SchedulerOptions) {
    const n = Math.max(1, Math.floor(opts.workers));
    this.slots = Array.from({ length: n }, () => ({ task: null, retired: false }));
    this.configuredFloor = Math.max(0, Math.floor(opts.parseFloorWorkers));
  }

  /** Queue a task. A group that was moved with setGroupLane overrides `lane`. */
  enqueue(payload: T, lane: Lane, group?: string): ScheduledTask<T> {
    const actual = (group !== undefined && this.groupLane.get(group)) || lane;
    const task: ScheduledTask<T> = { id: this.nextId++, payload, group, lane: actual, cancelled: false };
    this.queues[LANES.indexOf(actual)].push(task);
    return task;
  }

  /**
   * Give the next task to a free worker. Returns null when no worker is free or nothing may start.
   * Call it in a loop until it returns null.
   */
  take(): Assignment<T> | null {
    const worker = this.slots.findIndex((s) => !s.retired && s.task === null);
    if (worker < 0) return null;
    const task = this.pick();
    if (!task) return null;
    this.slots[worker].task = task;
    return { worker, task };
  }

  /** The worker's task ended (either way). Returns it; `cancelled` says whether to drop its result. */
  finish(worker: number): ScheduledTask<T> | null {
    const slot = this.slots[worker];
    const task = slot?.task ?? null;
    if (!task) return null;
    slot.task = null;
    if (!task.cancelled) this.completed++;
    return task;
  }

  /** Move every queued task of a group to a lane and route future ones there. Running tasks are untouched. */
  setGroupLane(group: string, lane: Lane): void {
    this.groupLane.set(group, lane);
    const target = LANES.indexOf(lane);
    const moved: ScheduledTask<T>[] = [];
    this.queues.forEach((q, i) => { if (i !== target) moved.push(...q.extract((t) => t.group === group)); });
    if (!moved.length) return;
    for (const t of moved) t.lane = lane;
    this.queues[target].merge(moved);
  }

  /** 0 = run everything; 1 = start nothing from parse and below; 2 = nor from selectedOverlay. */
  setParkLevel(level: ParkLevel): void { this.parkLevel = level; }

  /**
   * Drop queued tasks (all, or one group's) and flag the matching running ones as cancelled.
   * Returns both, so the driver can reject them; a running task still occupies its worker until finish().
   */
  cancel(group?: string): ScheduledTask<T>[] {
    const match = (t: ScheduledTask<T>) => group === undefined || t.group === group;
    const out: ScheduledTask<T>[] = [];
    for (const q of this.queues) out.push(...q.extract(match));
    for (const s of this.slots) {
      if (s.task && !s.task.cancelled && match(s.task)) { s.task.cancelled = true; out.push(s.task); }
    }
    return out;
  }

  /** Take a worker slot out of service for good (its Worker could not be replaced). */
  retire(worker: number): void {
    const slot = this.slots[worker];
    if (slot) slot.retired = true;
  }

  stats(): PoolStats {
    const live = this.slots.filter((s) => !s.retired);
    const busy = live.filter((s) => s.task !== null).length;
    const queued = Object.fromEntries(LANES.map((l, i) => [l, this.queues[i].length])) as Record<Lane, number>;
    let held = 0;
    for (let i = HELD_FROM[this.parkLevel]; i < LANES.length; i++) held += this.queues[i].length;
    // Workers that are idle only because of the park level.
    const parked = Math.min(live.length - busy, held);
    return { workers: live.length, busy, parked, queued, completed: this.completed };
  }

  private pick(): ScheduledTask<T> | undefined {
    const heldFrom = HELD_FROM[this.parkLevel];
    for (let i = 0; i < heldFrom; i++) {
      if (this.queues[i].length === 0) continue;
      if (i === SELECTED && this.parseIsOwed(heldFrom)) return this.queues[PARSE].shift();
      return this.queues[i].shift();
    }
    return undefined;
  }

  /**
   * The parse floor: asked when a free worker is about to take a selected-overlay task. True when
   * that worker should take a parse task instead.
   */
  private parseIsOwed(heldFrom: number): boolean {
    if (PARSE >= heldFrom || this.queues[PARSE].length === 0 || this.configuredFloor === 0) return false;
    const live = this.slots.reduce((n, s) => n + (s.retired ? 0 : 1), 0);
    // The selected overlay outranks parse, so the floor never takes the last worker from it.
    const floor = Math.min(this.configuredFloor, live - 1);
    if (floor > 0) {
      const onParse = this.slots.reduce((n, s) => n + (!s.retired && s.task?.lane === 'parse' ? 1 : 0), 0);
      return onParse < floor;
    }
    // One worker cannot hold a floor and serve the overlay at once: the two lanes take turns.
    this.parseTurn = !this.parseTurn;
    return !this.parseTurn;
  }
}
