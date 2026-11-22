// File paths in the assistant's answer. A piece of inline code, or the text of a link, that names a
// real file on the map becomes a button that selects the file and flies to it. `resolveMention` is
// the pure part (is this text a file here?); `linkPaths` rewrites a rendered answer.
import type { ModelReplica } from '../../contracts/store';
import { allPaths, cleanPath, findFile } from './tools/lookup';

const tails = new WeakMap<ModelReplica, { rev: number; byName: Map<string, string[]> }>();

/** Paths by file name, rebuilt when the replica has moved on. */
function byName(replica: ModelReplica): Map<string, string[]> {
  let cached = tails.get(replica);
  if (!cached || cached.rev !== replica.rev) {
    const map = new Map<string, string[]>();
    for (const path of allPaths(replica)) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const list = map.get(name);
      if (list) list.push(path); else map.set(name, [path]);
    }
    tails.set(replica, cached = { rev: replica.rev, byName: map });
  }
  return cached.byName;
}

/**
 * The file on the map that a piece of text names, or null. The whole path as the map spells it
 * (a leading "./" and a ":line" tail are allowed), or the end of a path ("app/store.ts", "store.ts")
 * when exactly one file ends that way. Prose, code and anything with a space in it is not a path.
 */
export function resolveMention(replica: ModelReplica, text: string): string | null {
  const raw = text.trim();
  if (raw === '' || raw.length > 300 || /\s/.test(raw)) return null;
  const path = cleanPath(raw);
  if (path === '' || path.endsWith('/')) return null;
  const exact = findFile(replica, path);
  if (exact) return exact.path;
  // a file name needs its extension to count: "store" alone is a word, not a file
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (!name.includes('.')) return null;
  const ending = (byName(replica).get(name) ?? []).filter((p) => p === path || p.endsWith(`/${path}`));
  return ending.length === 1 ? ending[0]! : null;
}

/** A link's target as a path, when it is a relative one: "src/a.ts#L10" → "src/a.ts". '' for a link to the web. */
export function linkTarget(href: string): string {
  if (href === '' || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return '';
  const path = href.replace(/[#?].*$/, '');
  try { return decodeURI(path); } catch { return path; }
}

const SVG = 'http://www.w3.org/2000/svg';

/** The window-with-a-side-panel icon of ../ui (PanelIcon), built by hand because this is not React's tree. */
function panelIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg');
  const set = (el: Element, attrs: Record<string, string>) => { for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); };
  set(svg, {
    width: '13', height: '13', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
  });
  const frame = doc.createElementNS(SVG, 'rect');
  set(frame, { x: '3.5', y: '5', width: '17', height: '14', rx: '2.5' });
  const divider = doc.createElementNS(SVG, 'path');
  set(divider, { d: 'M14.5 5v14' });
  svg.append(frame, divider);
  return svg;
}

/**
 * Turn the mentions in a rendered answer into buttons. A mention is inline code (not a code block)
 * or a link whose text, or whose relative target, is a file on the map. Each becomes a pair: the
 * path (selects the file and flies to it) and a small second button (opens it in the File tab).
 * The buttons carry the path in `data-chat-path` / `data-chat-open`; the panel listens for the clicks.
 */
export function linkPaths(root: ParentNode, resolve: (text: string) => string | null): void {
  const doc = root.ownerDocument ?? document;
  const candidates = [...root.querySelectorAll<HTMLElement>('code, a')].filter((el) => !el.closest('pre'));
  for (const el of candidates) {
    if (!root.contains(el)) continue; // inside a link that has already been replaced
    const text = el.textContent ?? '';
    const path = resolve(text) ?? (el.tagName === 'A' ? resolve(linkTarget(el.getAttribute('href') ?? '')) : null);
    if (path === null) continue;

    const wrap = doc.createElement('span');
    wrap.className = 'gm-chat-ref';
    const go = doc.createElement('button');
    go.type = 'button';
    go.className = 'gm-chat-path';
    go.dataset.chatPath = path;
    go.title = `Select ${path} and fly to it (Shift+click opens it)`;
    go.textContent = text.trim();
    const open = doc.createElement('button');
    open.type = 'button';
    open.className = 'gm-chat-open';
    open.dataset.chatOpen = path;
    open.title = 'Open in the File tab';
    open.setAttribute('aria-label', `Open ${path} in the File tab`);
    open.append(panelIcon(doc));
    wrap.append(go, open);
    el.replaceWith(wrap);
  }
}
