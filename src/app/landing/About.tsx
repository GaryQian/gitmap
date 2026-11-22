// Top right of the landing page: a round "i" pill and the card it opens. It says what the app is,
// that the code stays in the browser, and that AI is opt-in. Same open/close behaviour as settings.
import { useEffect, useId, useRef, useState } from 'react';
import { config } from '../../config';
import { LAYER, useDismissable } from '../keys';
import { Card, InfoIcon, PillButton } from '../ui';
import './about.css';

export function About() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const cardId = useId();
  const title = config.app.title;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  useDismissable(open, () => {
    setOpen(false);
    button.current?.focus();
  }, { layer: LAYER.card });

  return (
    <div className="gm-about" ref={wrap}>
      <PillButton
        ref={button}
        round
        blur
        active={open}
        aria-label={`About ${title}`}
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        title={`About ${title}`}
        onClick={() => setOpen((o) => !o)}
      >
        <InfoIcon />
      </PillButton>
      {open && (
        <Card blur id={cardId} className="gm-about-card" role="group" aria-label={`About ${title}`}>
          <h2 className="gm-about-heading">What this is</h2>
          <p>
            {title} turns a code repository into a 3D map you can explore. Each file is a sphere, and files that
            depend on each other gather into cities and districts.
          </p>
          <h2 className="gm-about-heading">Your code stays on your computer</h2>
          <p>
            The folder is read, parsed and laid out entirely in this browser. Nothing is uploaded and there is no
            account. Saved maps are kept only in this browser, and you can delete them at any time.
          </p>
          <h2 className="gm-about-heading">AI is optional</h2>
          {config.ai.enabled ? (
            <p>
              AI notes add city summaries, points of interest and a guided tour. They are off until you allow them
              for a repo, and only then are short excerpts of its code sent to the AI provider. Files that look like
              secrets are never sent. You can turn AI off again in settings, and the map works fully without it.
            </p>
          ) : (
            <p>AI notes are turned off in this build, so nothing is ever sent anywhere.</p>
          )}
        </Card>
      )}
    </div>
  );
}
