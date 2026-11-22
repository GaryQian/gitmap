// One stretch of the assistant's answer, rendered as sanitised markdown. While it streams the text is
// rendered again at most every CHAT_UI.renderMs; marked and DOMPurify arrive with a dynamic import,
// and until they do the words show as plain text. What is inserted is the fragment from
// markdown.ts, never an HTML string.
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useApp } from '../store';
import { cx } from '../ui';
import { resolveMention } from './paths';
import { CHAT_UI } from './tunables';

type MarkdownModule = typeof import('./markdown');
let markdown: MarkdownModule | null = null;
let loading: Promise<MarkdownModule> | null = null;
const loadMarkdown = (): Promise<MarkdownModule> => (loading ??= import('./markdown').then((m) => (markdown = m)));

/** Fetch the markdown chunk ahead of the first answer (the panel calls this as it opens). */
export function preloadMarkdown(): void {
  // a failure is tried again by the first answer, which shows its words as plain text meanwhile
  loadMarkdown().catch(() => { loading = null; });
}

export function Answer({ text, streaming }: { text: string; streaming: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(text);
  latest.current = text;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const painted = useRef(-Infinity);

  const paint = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const el = host.current;
    if (!el) return;
    painted.current = performance.now();
    const replica = useApp.getState().session?.replica ?? null;
    try {
      if (!markdown) throw new Error('not loaded yet');
      el.replaceChildren(markdown.renderAnswer(latest.current, (mention) => (replica ? resolveMention(replica, mention) : null)));
      el.classList.remove('is-plain');
    } catch {
      el.textContent = latest.current;
      el.classList.add('is-plain');
    }
  }, []);

  useLayoutEffect(() => {
    if (!markdown) void loadMarkdown().then(paint, () => {});
    if (!streaming) { paint(); return; }
    if (timer.current !== undefined) return; // a render is already on its way; it will take the newest text
    const wait = CHAT_UI.renderMs - (performance.now() - painted.current);
    if (wait <= 0) paint(); else timer.current = setTimeout(paint, wait);
  }, [text, streaming, paint]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return <div className={cx('gm-chat-answer', streaming && 'is-streaming')} ref={host} />;
}
