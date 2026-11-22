// The pure rules of the summary card: which summary a pill gets, what the card says, and where it
// goes. No DOM in here.
import type { Annotation, NodeRef, Summary } from '../../model/types';

export interface Size { width: number; height: number }
export interface Rect extends Size { x: number; y: number }

/** The summary written for a node: the last one in the list wins. Other annotations are ignored. */
export function summaryFor(annotations: readonly Annotation[], ref: NodeRef): Summary | null {
  let found: Summary | null = null;
  for (const a of annotations) {
    if (a.type === 'summary' && a.parent === ref && a.text.trim() !== '') found = a;
  }
  return found;
}

/** Letters and digits only, so "request-handling" and "Request handling" compare equal. */
function bare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The card's title: the summary's label, unless it is missing or merely repeats the name on the pill. */
export function titleFor(label: string | undefined, name: string): string | null {
  const title = label?.trim() ?? '';
  if (title === '' || bare(title) === bare(name)) return null;
  return title;
}

/** Work reported by a subsystem and not yet finished (the store's `progress` entries). */
export function inFlight(progress: { done: number; total: number } | undefined): boolean {
  return !!progress && progress.total > 0 && progress.done < progress.total;
}

export type CardContent =
  | { kind: 'summary'; title: string | null; text: string }
  /** No summary yet, and one is being written. */
  | { kind: 'pending' };

/**
 * What the card of the node `ref`, named `name` on its pill, says; null when there is nothing to
 * show. Only cities are summarised, so only a city is ever "on its way"; a district shows its summary
 * if one exists.
 */
export function cardContent(annotations: readonly Annotation[], ref: NodeRef, name: string, generating: boolean): CardContent | null {
  const summary = summaryFor(annotations, ref);
  if (summary) return { kind: 'summary', title: titleFor(summary.label, name), text: summary.text.trim() };
  return generating && ref.startsWith('c:') ? { kind: 'pending' } : null;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export interface CardSpot { x: number; y: number; side: 'below' | 'above' }

/**
 * Where a card of size `card` goes for a pill at `pill`, all in the coordinates of a view of size
 * `view`. Centred under the pill; above it when it does not fit below, or when only the place above
 * is clear of the `avoid` boxes (fixed chrome, open cards). Kept `margin` inside the view sideways.
 * It never covers the pill: in a view too short for either side it takes the roomier one and runs
 * off the edge instead.
 */
export function placeCard(
  pill: Rect, card: Size, view: Size, { gap, margin }: { gap: number; margin: number }, avoid: Iterable<Rect> = [],
): CardSpot {
  const x = Math.max(margin, Math.min(pill.x + pill.width / 2 - card.width / 2, view.width - card.width - margin));
  const below = pill.y + pill.height + gap;
  const above = pill.y - gap - card.height;
  const fitsBelow = below + card.height <= view.height - margin;
  const fitsAbove = above >= margin;
  const boxes = [...avoid];
  const clear = (y: number) => !boxes.some((box) => overlaps({ x, y, ...card }, box));
  const spot = (side: 'below' | 'above'): CardSpot => ({ x, y: side === 'below' ? below : above, side });

  if (fitsBelow && clear(below)) return spot('below');
  if (fitsAbove && clear(above)) return spot('above');
  if (fitsBelow) return spot('below');
  if (fitsAbove) return spot('above');
  return spot(view.height - (pill.y + pill.height) >= pill.y ? 'below' : 'above');
}
