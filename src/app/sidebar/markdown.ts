// Markdown → a sanitised DOM fragment. Loaded on demand (MarkdownPreview.tsx imports it dynamically).
//
// The text comes from the repo being viewed, so it is untrusted: a README may contain any HTML.
// marked's output goes through DOMPurify into an inert fragment, and the fragment is tightened
// further before it touches the page. Nothing here returns an HTML string.
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const marked = new Marked({ gfm: true, breaks: false });

/** Tags a README has no use for in a reader: anything that submits, embeds, plays or restyles. */
const FORBID_TAGS = [
  'style', 'form', 'button', 'textarea', 'select', 'option', 'dialog', 'video', 'audio', 'source', 'track', 'picture',
  'map', 'area', 'nav', 'template', 'slot',
];
/** `style`, `class` and `id` would let a document draw over, or pass itself off as, the app's own chrome. */
const FORBID_ATTR = ['style', 'class', 'id', 'name', 'srcset', 'sizes', 'usemap', 'ping', 'download', 'target', 'tabindex', 'contenteditable', 'draggable'];

const WEB_LINK = /^(https?:|mailto:)/i;
const WEB_IMAGE = /^https?:/i;

/** An image that is not shown: its alt text in its place, or nothing when it has none. */
export function imagePlaceholder(doc: Document, alt: string | null): Node {
  const text = alt?.trim();
  if (!text) return doc.createTextNode('');
  const span = doc.createElement('span');
  span.dataset.gmImage = 'missing';
  span.textContent = text;
  return span;
}

/**
 * Render markdown for the preview.
 * - Links to the web open in a new tab with `rel="noopener noreferrer"`; every other link (relative
 *   paths, in-page anchors, other schemes) loses its `href` and reads as plain text.
 * - Images with absolute http(s) URLs load, without a referrer; images with relative URLs are not
 *   loaded and show their alt text. The fragment is inert until it is inserted, so nothing is
 *   fetched before this has run.
 */
export function renderMarkdown(source: string): DocumentFragment {
  const html = marked.parse(source, { async: false });
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
  });
  const doc = fragment.ownerDocument;

  for (const a of fragment.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    if (WEB_LINK.test(href.trim())) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('href');
    }
  }

  for (const img of fragment.querySelectorAll('img')) {
    const src = (img.getAttribute('src') ?? '').trim();
    if (!WEB_IMAGE.test(src)) {
      img.replaceWith(imagePlaceholder(doc, img.getAttribute('alt')));
      continue;
    }
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.setAttribute('referrerpolicy', 'no-referrer');
    // the app is cross-origin isolated (PLAN.md §3): an image from another origin loads only as a CORS request
    img.setAttribute('crossorigin', 'anonymous');
  }

  // task lists: the only inputs kept are the checkboxes marked wrote, and they do nothing
  for (const input of fragment.querySelectorAll('input')) {
    if (input.getAttribute('type') !== 'checkbox') { input.remove(); continue; }
    input.setAttribute('disabled', '');
  }

  return fragment;
}
