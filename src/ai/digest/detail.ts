// Context for one detail button (PLAN.md §11.1): the file's skeleton, or its text when the caller
// read it and it is small enough, its strongest neighbours in both directions with their
// signatures, and the district and city it sits in — under its own budget.
import { isNodeRef, parseRef } from '../../model/types';
import type { NodeRef } from '../../model/types';
import { Ctx } from './ctx';
import type { DigestInput } from './ctx';
import { looksSecret } from './filters';
import { Cite, entry, render, select } from './items';
import type { Entry } from './items';
import { EXCLUDED, neighboursOf } from './model';
import type { Neighbour, UnitInfo } from './model';
import { cmpStr, oneLine } from './seeded';
import { skeletonText } from './skeletons';
import { cityBlock, districtBlock, NOTATION } from './structure';
import { estimateTokens } from './tokens';
import { LOCAL } from './tunables';

export interface DetailContext {
  /** Empty when the context is withheld. */
  context: string;
  /** Every NodeRef written in the context, sorted. */
  refs: NodeRef[];
  tokens: number;
  /**
   * Why there is no context, or null. 'secret': the file is secret-named or holds key-shaped
   * content, so nothing of it may be sent (PLAN.md §11.2); the button says so instead of calling
   * the model. 'excluded': a vendored or generated file. 'unknown': the reference is not a file on the map.
   */
  withheld: null | 'secret' | 'excluded' | 'unknown';
}

const none = (withheld: DetailContext['withheld']): DetailContext => ({ context: '', refs: [], tokens: 0, withheld });

function fenced(text: string, lang: string): string {
  let longest = 2;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}${/^[\w+#-]+$/.test(lang) ? lang : ''}\n${text.replace(/\s+$/, '')}\n${fence}`;
}

function weight(milli: number): string {
  const w = milli / 1000;
  return w >= 10 ? String(Math.round(w)) : w.toFixed(1);
}

export function buildDetailContext(input: DigestInput, poi: { parent: NodeRef }, opts: { fileText?: string } = {}): DetailContext {
  const ctx = new Ctx(input);
  const { view } = ctx;
  if (!isNodeRef(poi.parent)) return none('unknown');
  const { kind, id } = parseRef(poi.parent);
  const index = kind === 'unit' ? view.unitIndex.get(id) : kind === 'file' ? view.unitOfFile.get(id) : undefined;
  if (index === undefined) return none('unknown');
  const u = view.units[index];
  if (u.flags & EXCLUDED) return none('excluded');
  if (ctx.unitWithheld(u) || (opts.fileText !== undefined && looksSecret(opts.fileText))) return none('secret');

  const budget = Math.round(ctx.config.ai.digestTokens * LOCAL.detail.share);
  const entries: Entry[] = [];

  // Where it sits.
  let cite = new Cite();
  const head = [`# File ${cite.r(u.ref)}`, NOTATION];
  if (u.district >= 0) {
    const district = view.districts[u.district], city = view.cities[u.city];
    head.push('', '## Where it sits (measured)', `district ${districtBlock(ctx, district, cite)}`, `city ${cityBlock(ctx, city, cite)}`);
    const summary = input.replica.annotations.find((a) => a.type === 'summary' && a.parent === city.ref);
    if (summary?.type === 'summary') head.push(`city summary (written earlier by a model): ${oneLine(summary.text, 400)}`);
  }
  const headRefs = cite.refs;

  // The file itself: its text when given and small enough, else its skeleton.
  const fileBudget = Math.floor(budget * LOCAL.detail.fileShare);
  cite = new Cite();
  const facts = `${u.lang}, ${u.loc} lines, fan-in ${u.fanIn}, fan-out ${u.fanOut}`;
  let file: string;
  const text = opts.fileText;
  if (text !== undefined && text.trim() && estimateTokens(text) <= fileBudget) {
    file = `## The file (full text)\n${cite.r(u.ref)} — ${facts}\n${fenced(text, u.lang)}`;
  } else {
    const skeleton = skeletonText(ctx, u, fileBudget, cite, '');
    file = skeleton === null
      ? `## The file\n${cite.r(u.ref)} — ${facts}\n(no signatures are available for this file)`
      : `## The file (signatures and doc comments; bodies omitted)\n${skeleton}`;
  }
  // The head and the file are one entry, the first, so they are always sent; neighbours fill what is left.
  entries.push(entry('file', [0], [...head, '', file].join('\n'), [...headRefs, ...cite.refs]));

  // Its neighbours, strongest first in priority, the two directions taking turns.
  const { out, in: inn } = neighboursOf(input.replica, view, index);
  const shown = (list: Neighbour[]) => list.filter((n) => ctx.citable(view.units[n.unit]) && !ctx.unitWithheld(view.units[n.unit]));
  const tests = inn.filter((n) => ctx.rules.test(view.units[n.unit].id)).length;
  const directions = [
    { key: 'out', pos: 2, list: shown(out).slice(0, LOCAL.detail.neighbours), total: out.length,
      title: `## Depends on (${out.length} files; the strongest links shown, measured)`, uses: 'uses from it' },
    { key: 'in', pos: 3, list: shown(inn).slice(0, LOCAL.detail.neighbours), total: inn.length,
      title: `## Used by (${inn.length} files${tests ? `, ${tests} of them tests` : ''}; the strongest links shown, measured)`, uses: 'uses from this file' },
  ];
  const neighbour = (n: Neighbour, uses: string, cite: Cite): string => {
    const other: UnitInfo = view.units[n.unit];
    const symbols = n.symbols.slice(0, LOCAL.detail.symbols).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
    const place = other.district >= 0 ? ` (${cite.r(view.districts[other.district].ref)})` : '';
    const line = `${cite.r(other.ref)}${place} — ${n.kind} link, w${weight(n.milli)}${symbols.length ? `; ${uses}: ${symbols.join(', ')}` : ''}`;
    // Its signatures, without the skeleton's own first line.
    const skeleton = skeletonText(ctx, other, LOCAL.detail.neighbourTokens, new Cite(), '');
    const signatures = skeleton === null ? [] : skeleton.split('\n').slice(1);
    return [line, ...signatures].join('\n');
  };
  for (const dir of directions) {
    entries.push(entry(dir.key, [dir.pos, 0], ['', dir.title, ...(dir.total === 0 ? ['(none)'] : [])].join('\n')));
  }
  for (let rank = 0; rank < LOCAL.detail.neighbours; rank++) {
    for (const dir of directions) {
      const n = dir.list[rank];
      if (!n) continue;
      const cite = new Cite();
      entries.push(entry(`${dir.key}:${n.unit}`, [dir.pos, 1, ctx.unitRank[n.unit]], neighbour(n, dir.uses, cite), cite.refs, dir.key));
    }
  }

  const { chosen } = select(entries, budget);
  const filled = render(chosen, false);
  return { context: filled.text, refs: [...new Set(filled.refs)].sort(cmpStr), tokens: filled.tokens, withheld: null };
}
