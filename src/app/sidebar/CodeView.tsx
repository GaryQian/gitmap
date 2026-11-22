// The source view. CodeMirror arrives with a dynamic import, so opening the first file is what pays
// for it; if that chunk cannot be loaded the text is still shown, plainly.
import { useEffect, useRef, useState } from 'react';

export interface CodeViewProps {
  text: string;
  fileName: string;
  /** The language CodeMirror picked for the file, for the header. */
  onLanguage?: (name: string) => void;
}

export function CodeView({ text, fileName, onLanguage }: CodeViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const report = useRef(onLanguage);
  report.current = onLanguage;
  const [stage, setStage] = useState<'loading' | 'ready' | 'plain'>('loading');

  useEffect(() => {
    let cancelled = false;
    let handle: { destroy(): void } | null = null;
    setStage('loading');
    import('./editor').then(
      (editor) => {
        if (cancelled || !host.current) return;
        handle = editor.mountCodeView(host.current, { text, fileName, onLanguage: (name) => report.current?.(name) });
        setStage('ready');
      },
      () => { if (!cancelled) setStage('plain'); },
    );
    return () => {
      cancelled = true;
      handle?.destroy();
    };
  }, [text, fileName]);

  return (
    <div className="gm-reader-code">
      {stage === 'loading' && <p className="gm-reader-note gm-reader-wait">Loading</p>}
      {stage === 'plain' && <pre className="gm-reader-plain" tabIndex={0} aria-label={`Contents of ${fileName}`}>{text}</pre>}
      <div className="gm-reader-cm" ref={host} hidden={stage !== 'ready'} />
    </div>
  );
}
