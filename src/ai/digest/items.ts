// Sections are built from entries: whole blocks of lines that are kept or dropped as a unit, so a
// section is only ever cut at an item boundary. Priority decides what is kept; `pos` decides where
// it is shown, and the two are unrelated on purpose (PLAN.md §11.2 "no order cues").
import type { NodeRef } from '../../model/types';
import { costOf, estimateTokens } from './tokens';

export interface Entry {
  key: string;
  text: string;
  /** Every NodeRef written in `text`. */
  refs: readonly NodeRef[];
  cost: number;
  /** Display position, compared element by element. */
  pos: readonly number[];
  /** Key of the entry this one sits under; it is pulled in with its first child. */
  parent?: string;
}

/** One section's text under a budget. */
export interface Filled {
  text: string;
  refs: NodeRef[];
  tokens: number;
  /** Something was left out or cut for lack of budget: the section could use more. */
  truncated: boolean;
}

export interface Section {
  fill(budget: number): Filled;
}

/** Collects the refs written into a line: `${cite.r(unit.ref)} …`. */
export class Cite {
  readonly refs: NodeRef[] = [];
  readonly r = (ref: NodeRef): NodeRef => {
    this.refs.push(ref);
    return ref;
  };
}

export function entry(key: string, pos: readonly number[], text: string, refs: readonly NodeRef[] = [], parent?: string): Entry {
  return { key, text, refs, cost: costOf(text), pos, parent };
}

function comparePos(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * First fit in priority order. The first entry (the section's heading) is always kept. An entry
 * brings its missing ancestors with it, and is skipped when it does not fit together with them.
 */
export function select(entries: readonly Entry[], budget: number): { chosen: Entry[]; truncated: boolean } {
  const byKey = new Map<string, Entry>();
  for (const e of entries) byKey.set(e.key, e);
  const taken = new Set<string>();
  const chosen: Entry[] = [];
  let used = 0, truncated = false;
  entries.forEach((e, i) => {
    if (taken.has(e.key)) return;
    const chain = [e];
    let cost = e.cost;
    for (let p = e.parent === undefined ? undefined : byKey.get(e.parent); p && !taken.has(p.key); p = p.parent === undefined ? undefined : byKey.get(p.parent)) {
      chain.push(p);
      cost += p.cost;
    }
    if (i > 0 && used + cost > budget) { truncated = true; return; }
    for (const c of chain) { taken.add(c.key); chosen.push(c); }
    used += cost;
  });
  return { chosen, truncated };
}

export function render(chosen: readonly Entry[], truncated: boolean): Filled {
  const sorted = [...chosen].sort((a, b) => comparePos(a.pos, b.pos));
  const text = sorted.map((e) => e.text).join('\n');
  const refs: NodeRef[] = [];
  for (const e of sorted) for (const r of e.refs) refs.push(r);
  return { text, refs, tokens: estimateTokens(text), truncated };
}
