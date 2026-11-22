// Model-written markdown → HTML that is safe to put in the card. `marked` parses it; DOMPurify then
// keeps only plain text structure. No images, styles, forms or scripts: nothing the model writes may
// load a remote resource or run.
import createDOMPurify from 'dompurify';
import { marked } from 'marked';

const TAGS = [
  'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

let purify: ReturnType<typeof createDOMPurify> | null = null;

function sanitizer(): ReturnType<typeof createDOMPurify> {
  if (purify) return purify;
  // an instance of our own, so the link hook below does not leak into other users of DOMPurify
  purify = createDOMPurify(window);
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return;
    // links leave the map in a new tab and tell the destination nothing about it
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });
  return purify;
}

export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true });
  return sanitizer().sanitize(html, { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ['href', 'title', 'align'], ALLOW_DATA_ATTR: false });
}
