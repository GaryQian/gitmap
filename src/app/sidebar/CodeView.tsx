// The source view and editor. CodeMirror arrives with a dynamic import, so opening the first file is
// what pays for it; if that chunk cannot be loaded the text is still shown, plainly.
//
// The editor is created once per mount with `text` as its starting content and owns the text from
// then on; give it a `key` per file so another file gets a fresh editor.
import { useEffect, useRef, useState } from 'react';

export interface CodeViewProps {
  text: string;
  fileName: string;
  readOnly?: boolean;
  onChange?: (text: string) => void;
  onSave?: () => void;
  /** The language CodeMirror picked for the file, for the header. */
  onLanguage?: (name: string) => void;
}

export function CodeView({ text, fileName, readOnly = false, onChange, onSave, onLanguage }: CodeViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const calls = useRef({ onChange, onSave, onLanguage });
  calls.current = { onChange, onSave, onLanguage };
  const initial = useRef(text);
  const [stage, setStage] = useState<'loading' | 'ready' | 'plain'>('loading');

  useEffect(() => {
    let cancelled = false;
    let handle: { destroy(): void } | null = null;
    setStage('loading');
    import('./editor').then(
      (editor) => {
        if (cancelled || !host.current) return;
        handle = editor.mountEditor(host.current, {
          text: initial.current,
          fileName,
          readOnly,
          onChange: (t) => calls.current.onChange?.(t),
          onSave: () => calls.current.onSave?.(),
          onLanguage: (name) => calls.current.onLanguage?.(name),
        });
        setStage('ready');
      },
      () => { if (!cancelled) setStage('plain'); },
    );
    return () => {
      cancelled = true;
      handle?.destroy();
    };
  }, [fileName, readOnly]);

  return (
    <div className="gm-reader-code">
      {stage === 'loading' && <p className="gm-reader-note gm-reader-wait">Loading</p>}
      {stage === 'plain' && <pre className="gm-reader-plain" tabIndex={0} aria-label={`Contents of ${fileName}`}>{initial.current}</pre>}
      <div className="gm-reader-cm" ref={host} hidden={stage !== 'ready'} />
    </div>
  );
}
