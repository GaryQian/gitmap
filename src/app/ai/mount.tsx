// AI in the chrome (PLAN.md §11.4): asking once per repository before any code excerpt leaves the
// machine, starting generation once the answer is yes, answering the detail buttons, and one quiet
// line when something fails. While generation runs nothing is added to the screen: the shell's
// progress pill already shows the `ai` subsystem.
import { useEffect, useId, useMemo, type CSSProperties } from 'react';
import { aiAllowed, shouldAsk } from '../../ai';
import type { AppMount } from '../../contracts/app';
import { setDetailRequester } from '../poi';
import { useReplica, useSession } from '../store';
import { Card, Pill, PillButton } from '../ui';
import { sessionController } from './controller';
import { clearAiFailure, getAiConsent, requestDetail, setAiConsent, startGeneration, useAiUi } from './state';
import { AI_UI } from './tunables';
import './ai.css';

/** How a provider id from `config.ai.provider` is written in a sentence. */
const PROVIDER_NAMES: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' };
function providerName(id: string): string {
  return PROVIDER_NAMES[id.toLowerCase()] ?? (id ? id[0].toUpperCase() + id.slice(1) : 'the AI provider');
}

/**
 * The consent prompt, and the wiring that follows from the answer. A card at the bottom centre of
 * the overlay layer: it does not block the map and does not take the focus; its two buttons are
 * ordinary tab stops.
 */
function AiConsent() {
  const session = useSession();
  const replica = useReplica(); // re-renders as the model changes: meta arriving, annotations stored
  const explicit = useAiUi((s) => s.controller);
  const consentRev = useAiUi((s) => s.consentRev);
  const titleId = useId();

  const controller = useMemo(() => explicit ?? sessionController(session), [explicit, session]);
  const meta = replica?.meta ?? null;
  const repoId = meta?.id ?? null;
  // consentRev is the change signal for the stored answer
  const consent = useMemo(() => (repoId === null ? null : getAiConsent(repoId)), [repoId, consentRev]);

  const usable = session !== null && aiAllowed(session.config, meta) && controller.available;
  const granted = usable && consent === 'granted';
  const ask = usable && shouldAsk({ config: session.config, meta, annotations: replica?.annotations ?? [], consent });

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

  if (!ask || !session || repoId === null) return null;
  return (
    <div className="gm-ai-consent-wrap">
      <Card blur className="gm-ai-consent" role="region" aria-labelledby={titleId}>
        <h2 className="gm-ai-consent-title" id={titleId}>Add AI notes to this map?</h2>
        <p className="gm-ai-consent-text">
          Writing the summaries, points of interest and tour sends code excerpts
          to {providerName(session.config.ai.provider)}: signatures, doc comments and README excerpts, not whole files.
        </p>
        <p className="gm-ai-consent-text">Asking for more about a point of interest sends the one file it stands on.</p>
        <div className="gm-ai-consent-actions">
          <PillButton size="small" onClick={() => setAiConsent(repoId, 'declined')}>Not now</PillButton>
          <PillButton size="small" className="gm-ai-allow" onClick={() => setAiConsent(repoId, 'granted')}>Allow for this repo</PillButton>
        </div>
      </Card>
    </div>
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
      style={{ '--gm-ai-failure-ms': `${AI_UI.failureMs}ms` } as CSSProperties}
      onAnimationEnd={() => clearAiFailure(failure.id)}
    >
      <span>{failure.text}</span>
    </Pill>
  );
}

const mounts: AppMount[] = [
  { region: 'overlay', order: 10, Component: AiConsent },
  // bottom centre, above the tour pill (10): the top row is full, and a line this long would push its pills around
  { region: 'bottomCenter', order: 5, Component: AiFailure },
];
export default mounts;
