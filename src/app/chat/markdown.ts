// The assistant's markdown → a sanitised DOM fragment. Loaded on demand (Answer.tsx imports it
// dynamically, as the sidebar and the point-of-interest card do with theirs).
//
// The text is written by a model that has read the repository, so it is untrusted. marked's output
// goes through DOMPurify into an inert fragment that keeps only plain text structure: no images,
// styles, forms or scripts, so nothing in an answer can load a remote resource or run. Nothing here
// returns an HTML string.
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { linkPaths } from './paths';

const marked = new Marked({ gfm: true, breaks: false });

const TAGS = [
  'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

const WEB_LINK = /^(https?:|mailto:)/i;

/**
 * Render an answer. File paths that `resolve` knows become buttons (paths.ts). Links to the web open
 * in a new tab and tell the destination nothing; every other link loses its target and reads as text.
 */
export function renderAnswer(source: string, resolve: (text: string) => string | null): DocumentFragment {
  const html = marked.parse(source, { async: false });
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ['href', 'title', 'align'],
    ALLOW_DATA_ATTR: false,
  });
  linkPaths(fragment, resolve);
  for (const a of fragment.querySelectorAll('a')) {
    const href = (a.getAttribute('href') ?? '').trim();
    if (WEB_LINK.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('href');
    }
  }
  // a wide table scrolls by itself instead of widening the panel
  for (const table of fragment.querySelectorAll('table')) {
    const scroller = fragment.ownerDocument.createElement('div');
    scroller.className = 'gm-chat-table';
    table.replaceWith(scroller);
    scroller.append(table);
  }
  return fragment;
}
