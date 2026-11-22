// The rendered view of a markdown file. marked and DOMPurify arrive with a dynamic import; what is
// inserted is the sanitised fragment from markdown.ts, never an HTML string.
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MarkdownPreviewProps {
  text: string;
  fileName: string;
  /** Shown instead when the preview cannot be made (its chunk did not load, or the parser threw). */
  fallback: ReactNode;
}

export function MarkdownPreview({ text, fileName, fallback }: MarkdownPreviewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let cancelled = false;
    const el = host.current;
    setStage('loading');
    import('./markdown').then((md) => {
      if (cancelled || !el) return;
      el.replaceChildren(md.renderMarkdown(text));
      el.scrollTop = 0;
      setStage('ready');
    }).catch(() => { if (!cancelled) setStage('failed'); });

    // An image that fails (offline, or refused under cross-origin isolation) gives way to its alt text.
    // `error` does not bubble, so listen on the way down.
    const onError = (e: Event) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      void import('./markdown').then((md) => img.replaceWith(md.imagePlaceholder(document, img.getAttribute('alt'))), () => {});
    };
    el?.addEventListener('error', onError, true);
    return () => {
      cancelled = true;
      el?.removeEventListener('error', onError, true);
      el?.replaceChildren();
    };
  }, [text]);

  if (stage === 'failed') return <>{fallback}</>;
  return (
    <>
      {stage === 'loading' && <p className="gm-reader-note gm-reader-wait">Loading</p>}
      <div className="gm-md" ref={host} hidden={stage !== 'ready'} tabIndex={0} aria-label={`Preview of ${fileName}`} />
    </>
  );
}
