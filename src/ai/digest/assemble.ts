// The budget (PLAN.md §11.2): a fixed split between structure, skeletons and docs so that no source
// dominates. A section that does not need its share leaves the remainder to the sections that were
// cut, in a fixed order.
import type { Config } from '../../config';
import type { NodeRef } from '../../model/types';
import type { Filled, Section } from './items';
import { cmpStr } from './seeded';
import { estimateTokens } from './tokens';

export type SectionName = 'structure' | 'skeletons' | 'docs';
export interface DigestTokens { structure: number; skeletons: number; docs: number; total: number }

/** The order of the sections in the text: measurements first, so the docs label can point back at them. */
const TEXT_ORDER: readonly SectionName[] = ['structure', 'skeletons', 'docs'];
/** Who is offered the spare budget first. Skeletons can nearly always use more. */
const REFILL_ORDER: readonly SectionName[] = ['skeletons', 'structure', 'docs'];
const SEPARATOR = '\n\n';

export interface Assembled { text: string; refs: NodeRef[]; tokens: DigestTokens }

export function assemble(sections: Record<SectionName, Section>, budget: number, split: Config['ai']['budgetSplit']): Assembled {
  // Sections are measured one by one; the separators between them are paid for up front.
  const room = Math.max(0, budget - estimateTokens(SEPARATOR) * (TEXT_ORDER.length - 1));
  const share: Record<SectionName, number> = {
    structure: Math.floor(room * split.structure),
    skeletons: Math.floor(room * split.skeletons),
    docs: Math.floor(room * split.docs),
  };
  const filled = {} as Record<SectionName, Filled>;
  for (const name of TEXT_ORDER) filled[name] = sections[name].fill(share[name]);

  const spare = () => room - TEXT_ORDER.reduce((sum, name) => sum + filled[name].tokens, 0);
  for (const name of REFILL_ORDER) {
    const extra = spare();
    if (extra <= 0) break;
    if (filled[name].truncated) filled[name] = sections[name].fill(filled[name].tokens + extra);
  }

  const text = TEXT_ORDER.map((name) => filled[name].text).join(SEPARATOR);
  const refs = new Set<NodeRef>();
  for (const name of TEXT_ORDER) for (const r of filled[name].refs) refs.add(r);
  return {
    text,
    refs: [...refs].sort(cmpStr),
    tokens: {
      structure: filled.structure.tokens, skeletons: filled.skeletons.tokens, docs: filled.docs.tokens,
      total: estimateTokens(text),
    },
  };
}
