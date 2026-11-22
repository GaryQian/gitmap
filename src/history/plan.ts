// The planner: read commits newest-first and hand out pages of commit records for the driver to cut
// into chunks. Commits come out in commit-date order, each once, as `git log` lists them (same-date
// commits are ordered by id). A page is a pure function of its input: the queue and the set of
// commits already queued travel with it, so any worker can plan the next page.
//
// With `stopAt` (an incremental walk) the page that first meets that commit finishes the job in one
// go, the way git limits `old..new`: commits reachable from stopAt are marked uninteresting, also
// when they were already taken from the queue, and the walk ends once nothing interesting is left.
import type { HistoryRepo } from './repo';
import { SeenSet } from './seen';
import type { FrontierEntry, PlanFrontier, PlanInput, PlanPage, PlanStop, PlannedCommit } from './types';

/** As in git's revision walk: how many uninteresting commits older than the newest result to look at before stopping. */
const SLOP = 5;
/** The clock is read once per this many commits. */
const CLOCK_EVERY = 16;

interface Node extends FrontierEntry {
  /** Reachable from stopAt. */
  unint?: boolean;
  popped?: boolean;
  /** Set when the node is taken from the queue. */
  parentTree?: string | null;
  boundary?: boolean;
}

/** Max-heap by commit date; ties by id, so the order does not depend on where pages were cut. */
class Queue {
  private h: Node[] = [];
  get size(): number { return this.h.length; }
  get top(): Node { return this.h[0]; }
  get items(): readonly Node[] { return this.h; }
  private before(a: Node, b: Node): boolean {
    return a.date > b.date || (a.date === b.date && a.oid < b.oid);
  }
  push(n: Node): void {
    const h = this.h;
    h.push(n);
    let k = h.length - 1;
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (!this.before(h[k], h[up])) break;
      [h[up], h[k]] = [h[k], h[up]];
      k = up;
    }
  }
  pop(): Node {
    const h = this.h;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < h.length && this.before(h[l], h[m])) m = l;
        if (r < h.length && this.before(h[r], h[m])) m = r;
        if (m === k) break;
        [h[m], h[k]] = [h[k], h[m]];
        k = m;
      }
    }
    return top;
  }
}

function entryOf(n: Node): FrontierEntry {
  return { oid: n.oid, date: n.date, tree: n.tree, parents: n.parents, ident: n.ident, authorTime: n.authorTime };
}

const EMPTY_PAGE = { shallow: false, commits: [], authors: [], frontier: null, stop: 'none' as PlanStop, missingParents: 0, usedCommitGraph: false };

/**
 * Plan one page. `budgetMs` bounds the time of an ordinary page; the page that limits an incremental
 * walk runs until it is done or `input.remaining` commits have been taken.
 */
export function planPage(repo: HistoryRepo, input: PlanInput, budgetMs: number): PlanPage {
  const startedAt = Date.now();
  const useGraph = input.useCommitGraph !== false && repo.commitGraph() !== null;
  const firstParentOnly = input.firstParentOnly;
  const shallow = repo.git.isShallow();
  const stopAt = input.stopAt ?? null;
  const done = (page: Partial<PlanPage>): PlanPage =>
    ({ ...EMPTY_PAGE, headOid: null, shallow, usedCommitGraph: useGraph, ...page, startedAt, endedAt: Date.now() });

  const queue = new Queue();
  /** Every commit this page knows: the queue it was given, plus what it read. */
  const nodes = new Map<string, Node>();
  let seen: SeenSet;
  let headOid: string | null = null;
  let stop: PlanStop = stopAt ? 'searching' : 'none';

  if (input.frontier) {
    seen = new SeenSet(input.frontier.seen, input.frontier.seenCount);
    for (const e of input.frontier.entries) {
      const n: Node = { ...e };
      nodes.set(n.oid, n);
      queue.push(n);
    }
  } else {
    seen = new SeenSet();
    const named = input.start ?? repo.git.head().oid;
    if (!named) return done({ unavailable: { reason: 'empty', message: 'This repository has no commits yet.' } });
    headOid = repo.peelToCommit(named);
    const head = headOid ? repo.readCommit(headOid, useGraph) : null;
    if (!headOid || !head) return done({ unavailable: { reason: 'unreadable', message: `Commit ${named} cannot be read.` } });
    if (headOid === stopAt) return done({ headOid, stop: 'reached' });
    seen.add(headOid);
    nodes.set(headOid, head);
    queue.push(head);
  }

  const popped: Node[] = [];
  let missingParents = 0;
  /** Queued commits that are not marked uninteresting. Only tracked once stopAt has been met. */
  let interestingQueued = 0;
  let limiting = false;
  /** A commit handed out on an earlier page turned out to be reachable from stopAt. */
  let unsafe = false;
  let lastInterestingDate = Infinity;
  let slop = SLOP;

  const markUninteresting = (start: Node): void => {
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.unint) continue;
      n.unint = true;
      if (!n.popped) { interestingQueued--; continue; }
      // already taken from the queue: its parents were queued then, so pass the mark on
      for (const p of firstParentOnly ? n.parents.slice(0, 1) : n.parents) {
        const pn = nodes.get(p);
        if (pn) stack.push(pn);
        else if (seen.has(p)) unsafe = true;
      }
    }
  };
  const startLimiting = (): void => {
    limiting = true;
    stop = 'reached';
    interestingQueued = 0;
    for (const n of queue.items) if (!n.unint) interestingQueued++;
  };

  const remaining = Math.max(1, input.remaining);
  const limit = Math.max(1, Math.min(input.limit, remaining));
  let finished = false;
  while (queue.size > 0) {
    if (popped.length >= (limiting ? remaining : limit)) break;
    if (!limiting && popped.length > 0 && popped.length % CLOCK_EVERY === 0 && Date.now() - startedAt >= budgetMs) break;
    const n = queue.pop();
    n.popped = true;
    if (!n.unint && limiting) interestingQueued--;

    const parents = firstParentOnly ? n.parents.slice(0, 1) : n.parents;
    n.parentTree = null;
    for (let i = 0; i < parents.length; i++) {
      const p = parents[i];
      let pn = nodes.get(p);
      if (!pn) {
        if (seen.has(p)) {
          // queued and handed out on an earlier page (its date is newer than its child's)
          if (i === 0) {
            const again = repo.readCommit(p, useGraph);
            if (again) n.parentTree = again.tree; else n.boundary = true;
          }
          if (n.unint) unsafe = true;
          continue;
        }
        const read = repo.readCommit(p, useGraph);
        if (!read) {
          missingParents++;
          if (i === 0) n.boundary = true;
          continue;
        }
        pn = read as Node;
        if (firstParentOnly && p === stopAt && !n.unint) {
          // the mainline ends at the old head: its tree is needed, the commit is not walked again
          stop = 'reached';
          n.parentTree = pn.tree;
          continue;
        }
        seen.add(p);
        nodes.set(p, pn);
        queue.push(pn);
        if (limiting) interestingQueued++;
        if (p === stopAt && !limiting) startLimiting();
        if (n.unint || p === stopAt) markUninteresting(pn);
      } else if (n.unint) markUninteresting(pn);
      if (i === 0) n.parentTree = pn.tree;
    }
    popped.push(n);

    if (limiting) {
      if (unsafe) break;
      if (n.unint) {
        // git's still_interesting(): keep going while the queue may still hold ancestors of results
        if (queue.size === 0) break;
        if (lastInterestingDate <= queue.top.date || interestingQueued > 0) slop = SLOP;
        else if (--slop <= 0) { finished = true; break; }
      } else lastInterestingDate = n.date;
    }
  }
  if (queue.size === 0) finished = true;
  if (limiting && unsafe) finished = false;

  let out = popped;
  if (limiting) {
    if (finished) out = popped.filter((n) => !n.unint);
    else stop = 'abandoned'; // hand out everything taken so far and carry on as an ordinary walk
  }

  const authors: string[] = [];
  const authorIndex = new Map<string, number>();
  const commits: PlannedCommit[] = out.map((n) => {
    let author = -1;
    if (n.ident !== null) {
      const known = authorIndex.get(n.ident);
      if (known === undefined) {
        author = authors.length;
        authors.push(n.ident);
        authorIndex.set(n.ident, author);
      } else author = known;
    }
    const c: PlannedCommit = { oid: n.oid, tree: n.tree, parentTree: n.parentTree ?? null, author, time: n.authorTime, isMerge: n.parents.length > 1 };
    if (n.boundary) c.boundary = true;
    return c;
  });

  let frontier: PlanFrontier | null = null;
  if (!finished) frontier = { entries: queue.items.map(entryOf), seen: seen.buffer, seenCount: seen.count };
  return done({ headOid, commits, authors, frontier, stop, missingParents });
}
