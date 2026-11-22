// The rendered view of a markdown file. marked and DOMPurify arrive with a dynamic import; what is
// inserted is the sanitised fragment from markdown.ts, never an HTML string. It follows the text as
// it is edited, keeping its scroll position; a new file starts at the top.
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MarkdownPreviewProps {
  text: string;
  fileName: string;
  /** Shown instead when the preview cannot be made (its chunk did not load, or the parser threw). */
  fallback: ReactNode;
}

/** How long typing pauses before the preview catches up. */
const SETTLE_MS = 120;

export function MarkdownPreview({ text, fileName, fallback }: MarkdownPreviewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<'loading' | 'ready' | 'failed'>('loading');
  const rendered = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const el = host.current;
    const render = () => import('./markdown').then((md) => {
      if (cancelled || !el) return;
      const top = el.scrollTop;
      el.replaceChildren(md.renderMarkdown(text));
      el.scrollTop = rendered.current ? top : 0;
      rendered.current = true;
      setStage('ready');
    }).catch(() => { if (!cancelled) setStage('failed'); });
    // the first render is immediate; later ones wait for a pause in typing
    const timer = rendered.current ? setTimeout(render, SETTLE_MS) : (void render(), undefined);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text]);

  useEffect(() => {
    // An image that fails (offline, or refused under cross-origin isolation) gives way to its alt text.
    // `error` does not bubble, so listen on the way down.
    const el = host.current;
    const onError = (e: Event) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      void import('./markdown').then((md) => img.replaceWith(md.imagePlaceholder(document, img.getAttribute('alt'))), () => {});
    };
    el?.addEventListener('error', onError, true);
    return () => {
      el?.removeEventListener('error', onError, true);
      el?.replaceChildren();
    };
  }, []);

  if (stage === 'failed') return <>{fallback}</>;
  return (
    <>
      {stage === 'loading' && <p className="gm-reader-note gm-reader-wait">Loading</p>}
      <div className="gm-md" ref={host} hidden={stage !== 'ready'} tabIndex={0} aria-label={`Preview of ${fileName}`} />
    </>
  );
}
