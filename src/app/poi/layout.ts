// Where point-of-interest pills and their card go on screen. Pure: rectangles in, positions out.

export interface Size { width: number; height: number }
export interface Rect extends Size { x: number; y: number }

export interface PillRequest extends Size {
  id: string;
  /** Where the middle of the pill's lower edge wants to be: just above its parent star, on the beam. */
  x: number;
  y: number;
  /** Lower is placed first: the open pill, then the focused one, then by camera distance. */
  priority: number;
}

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

/**
 * Place pills in priority order. One that would overlap a pill already placed is nudged up its own
 * beam, a row at a time, up to `maxNudges` rows; if it still overlaps it is left out, so pills never
 * stack unreadably. Returns the top-left corner of every pill that shows.
 */
export function placePills(requests: readonly PillRequest[], gap: number, maxNudges: number): Map<string, Rect> {
  const placed = new Map<string, Rect>();
  const taken: Rect[] = [];
  const order = requests.map((r, i) => ({ r, i })).sort((a, b) => a.r.priority - b.r.priority || a.i - b.i);
  for (const { r } of order) {
    for (let n = 0; n <= maxNudges; n++) {
      const rect: Rect = { x: r.x - r.width / 2, y: r.y - r.height - n * (r.height + gap), width: r.width, height: r.height };
      if (taken.some((t) => overlaps(rect, t, gap))) continue;
      taken.push(rect);
      placed.set(r.id, rect);
      break;
    }
  }
  return placed;
}

export interface CardOptions { gap: number; margin: number; topMargin: number; rise: number }

/**
 * The detail card sits beside its pill: to the right, or to the left when there is no room, its top
 * a little above the pill's. It is then pushed back inside the view, so it stays readable when the
 * anchor nears an edge or leaves the screen.
 */
export function placeCard(pill: Rect, card: Size, view: Size, o: CardOptions): { x: number; y: number } {
  const right = pill.x + pill.width + o.gap;
  const left = pill.x - o.gap - card.width;
  const fitsRight = right + card.width <= view.width - o.margin;
  const x = fitsRight || left < o.margin ? right : left;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return {
    x: clamp(x, o.margin, view.width - o.margin - card.width),
    y: clamp(pill.y - o.rise, o.topMargin, view.height - o.margin - card.height),
  };
}
