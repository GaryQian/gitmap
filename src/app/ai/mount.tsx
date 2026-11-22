// AI in the chrome (PLAN.md §11.4): the prompt at the bottom centre (asking before any code excerpt
// leaves the machine, and afterwards one pill for as long as AI is not writing notes for this map),
// starting generation once the answer is yes, answering the detail buttons, and one quiet line when
// something fails. While generation runs nothing is added to the screen: the shell's progress pill
// already shows the `ai` subsystem. The settings card's "AI notes" row is in AiSettingsRow.tsx.
import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { AppMount } from '../../contracts/app';
import { setDetailRequester } from '../poi';
import { useApp, useSession } from '../store';
import { Card, Pill, PillButton } from '../ui';
import { aiCanRun, aiPrompt, inFlight, type AiPrompt } from './rules';
import { clearAiFailure, generationPending, requestDetail, retryGeneration, startGeneration, switchAi, useAiUi } from './state';
import { AI_UI } from './tunables';
import { useAiFacts } from './useAiFacts';
import './ai.css';

const NO_PROMPT: AiPrompt = { kind: 'none' };

/**
 * The prompt, and the wiring that follows from the answer. One slot at the bottom centre, above the
 * tour pill: the consent card while the viewer has not answered, and after that a single pill
 * whenever AI is not writing notes for this map (rules.ts has the cases). Neither blocks the map or
 * takes the focus; their buttons are ordinary tab stops.
 */
function AiPromptSlot() {
  const { session, replica, controller, meta, consent } = useAiFacts();
  const progress = useApp((s) => s.progress.ai);
  const titleId = useId();
  const pill = useRef<HTMLButtonElement>(null);
  /** "Not now" was pressed: its button is about to go, and the pill that replaces it takes the focus. */
  const handFocusOn = useRef(false);

  const available = controller.available;
  const granted = session !== null && consent === 'granted' && aiCanRun({ config: session.config, meta, available });

  // Consent given (now, or on an earlier visit): generate what is missing. A stored set that is
  // complete for the current digest makes no request, so this is safe on every visit.
  useEffect(() => {
    if (granted && session) startGeneration(session, controller);
  }, [granted, session, controller]);

  // The detail buttons call the model only with consent. Without a requester the card offers no
  // unanswered question, so there is never a dead button.
  useEffect(() => {
    if (!granted || !session) return;
    setDetailRequester((poi, question) => requestDetail(session, controller, poi.id, question));
    return () => setDetailRequester(null);
  }, [granted, session, controller]);

  const prompt = session === null ? NO_PROMPT : aiPrompt({
    config: session.config, meta, available, consent,
    annotations: replica?.annotations ?? [],
    busy: generationPending(session) || inFlight(progress),
  });

  const kind = prompt.kind;
  useLayoutEffect(() => {
    const nowhere = !document.activeElement || document.activeElement === document.body;
    if (kind === 'pill' && handFocusOn.current && nowhere) pill.current?.focus({ preventScroll: true });
    handFocusOn.current = false;
  }, [kind]);

  if (!session || prompt.kind === 'none') return null;
  if (prompt.kind === 'card') {
    return (
      <Card blur className="gm-ai-prompt gm-ai-consent" role="region" aria-labelledby={titleId}>
        <h2 className="gm-ai-consent-title" id={titleId}>Add AI notes to this map?</h2>
        <p className="gm-ai-consent-text">
          Adds city summaries, points of interest and a guided tour.
        </p>
        <div className="gm-ai-consent-actions">
          <PillButton size="small" onClick={() => { handFocusOn.current = true; switchAi(session, controller, 'off'); }}>Not now</PillButton>
          <PillButton size="small" className="gm-ai-allow" onClick={() => switchAi(session, controller, 'on')}>Allow for this repo</PillButton>
        </div>
      </Card>
    );
  }
  const act = prompt.action === 'retry'
    ? () => retryGeneration(session, controller)
    : () => switchAi(session, controller, 'on');
  return (
    <PillButton blur ref={pill} className="gm-ai-prompt gm-ai-prompt-pill" onClick={act}>
      {prompt.label}
    </PillButton>
  );
}

/** One quiet line at the bottom centre when generation or a detail request failed. It fades by itself. */
function AiFailure() {
  const session = useSession();
  const failure = useAiUi((s) => s.failure);
  // a line about one map does not follow the viewer to the next
  useEffect(() => () => clearAiFailure(), [session]);
  // the fade removes it; the timer is for a tab where animations do not run
  useEffect(() => {
    if (!failure) return;
    const timer = setTimeout(() => clearAiFailure(failure.id), AI_UI.failureMs + AI_UI.fadeMs + 1000);
    return () => clearTimeout(timer);
  }, [failure]);
  if (!failure) return null;
  return (
    <Pill
      key={failure.id}
      blur
      size="small"
      role="status"
      className="gm-ai-failure"
      title={failure.text}
      style={{ '--gm-ai-failure-ms': `${AI_UI.failureMs}ms` } as CSSProperties}
      onAnimationEnd={() => clearAiFailure(failure.id)}
    >
      <span>{failure.text}</span>
    </Pill>
  );
}

// Bottom centre, top to bottom: the failure line (5), the prompt (7), the tour pill (10). The top
// row is full, and a line this long would push its pills around.
const mounts: AppMount[] = [
  { region: 'bottomCenter', order: 5, Component: AiFailure },
  { region: 'bottomCenter', order: 7, Component: AiPromptSlot },
];
export default mounts;
