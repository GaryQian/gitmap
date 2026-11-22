// The detail card of a point of interest (PLAN.md §11.1, §17.6): what it is, the structural fact it
// rests on, a way to the file, and the four on-demand questions. Everything shown comes from the
// replica; a question is answered by the registered requester changing the model.
import { useEffect, useMemo, useState, type Ref } from 'react';
import { DETAIL_QUESTIONS, type DetailQuestion } from '../../contracts/ai';
import type { RenderApi } from '../../contracts/render';
import type { Poi, PoiDetail, PoiKind } from '../../model/types';
import { setFocus, setSelection } from '../store';
import { Card, CloseIcon, PillButton, cx } from '../ui';
import { renderMarkdown } from './markdown';
import type { PoiParent } from './pois';
import { usePoiUi } from './state';

/** The kinds in plain words. */
const KIND_WORDS: Record<PoiKind, string> = { entry: 'Entry point', core: 'Core', boundary: 'Boundary', data: 'Data', risk: 'Risk' };
const QUESTIONS = Object.keys(DETAIL_QUESTIONS) as DetailQuestion[];

type Status = PoiDetail['status'];
/** What a question's stored detail was when it was asked, to show "loading" until the model answers. */
type Asked = Partial<Record<DetailQuestion, { detail: PoiDetail | undefined; status: Status }>>;

const storedStatus = (poi: Poi, q: DetailQuestion): Status => poi.details[q]?.status ?? 'idle';

/** A request is still on its way while the model has not moved on from what was there when asked. */
function awaiting(poi: Poi, q: DetailQuestion, asked: Asked): boolean {
  const a = asked[q];
  if (!a || storedStatus(poi, q) !== a.status) return false;
  return a.status === 'idle' || poi.details[q] === a.detail;
}

function Markdown({ source }: { source: string }) {
  const html = useMemo(() => {
    try { return renderMarkdown(source); } catch { return null; }
  }, [source]);
  if (html === null) return <p className="gm-poi-md">{source}</p>;
  return <div className="gm-poi-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export interface PoiCardProps {
  poi: Poi;
  parent: PoiParent;
  render: RenderApi;
  id?: string;
  /** Close the card and put the focus back on its pill. */
  onClose: () => void;
  ref?: Ref<HTMLDivElement>;
}

export function PoiCard({ poi, parent, render, id, onClose, ref }: PoiCardProps) {
  const requester = usePoiUi((s) => s.requester);
  const [active, setActive] = useState<DetailQuestion | null>(null);
  const [asked, setAsked] = useState<Asked>({});

  // forget a request once the model has answered it (or failed), so a later failure can be retried
  useEffect(() => {
    const stale = QUESTIONS.filter((q) => asked[q] && !awaiting(poi, q, asked));
    if (stale.length) setAsked((a) => Object.fromEntries(Object.entries(a).filter(([q]) => !stale.includes(q as DetailQuestion))));
  }, [poi, asked]);

  const statusOf = (q: DetailQuestion): Status => (awaiting(poi, q, asked) ? 'loading' : storedStatus(poi, q));
  const ask = (q: DetailQuestion) => {
    if (!requester) return;
    setAsked((a) => ({ ...a, [q]: { detail: poi.details[q], status: storedStatus(poi, q) } }));
    requester(poi, q);
  };
  const choose = (q: DetailQuestion) => {
    const status = statusOf(q);
    if (status === 'idle') { ask(q); setActive(q); return; }
    setActive((cur) => (cur === q ? null : q));
  };
  const goToFile = () => {
    void render.flyTo(poi.parent);
    // selected, with this card staying as the one card on the star (the file's own card stays closed)
    setSelection([poi.parent]);
    setFocus(null);
  };

  // without a requester an unanswered question would be a dead control: it is not offered
  const offered = QUESTIONS.filter((q) => requester !== null || storedStatus(poi, q) !== 'idle');
  const shown = active !== null && offered.includes(active) ? active : null;
  const shownStatus = shown ? statusOf(shown) : null;
  const panelId = `gm-poi-panel-${poi.id}`;

  return (
    // a labelled group, not a dialog: it does not hold the focus, and the map around it stays in reach
    <Card id={id} className="gm-poi-card" role="group" aria-label={`${poi.label}, point of interest`} tabIndex={-1} ref={ref}>
      <div className="gm-poi-head">
        <span className="gm-poi-dot" aria-hidden="true" />
        <h2 className="gm-poi-title">{poi.label}</h2>
        <span className="gm-poi-kind">{KIND_WORDS[poi.kind] ?? poi.kind}</span>
        <button type="button" className="gm-poi-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="gm-poi-scroll">
        <div className="gm-poi-where">{parent.path}</div>
        <p className="gm-poi-summary">{poi.summary}</p>
        {poi.evidence && (
          <p className="gm-poi-evidence">
            <span className="gm-poi-evidence-label">Evidence</span>
            {poi.evidence}
          </p>
        )}
        <div className="gm-poi-actions">
          <PillButton size="small" onClick={goToFile}>Go to file</PillButton>
        </div>
        {offered.length > 0 && (
          <div className="gm-poi-questions" role="group" aria-label="More about this file">
            {offered.map((q) => {
              const status = statusOf(q);
              return (
                <PillButton
                  key={q}
                  size="small"
                  active={shown === q}
                  className={cx('gm-poi-question', `is-${status}`)}
                  aria-expanded={shown === q}
                  aria-controls={shown === q ? panelId : undefined}
                  aria-busy={status === 'loading' || undefined}
                  onClick={() => choose(q)}
                >
                  {DETAIL_QUESTIONS[q]}
                  {status === 'loading' && <span className="gm-poi-busy" aria-hidden="true" />}
                </PillButton>
              );
            })}
          </div>
        )}
        {shown && (
          <div className="gm-poi-panel" id={panelId} role="region" aria-label={DETAIL_QUESTIONS[shown]} aria-live="polite">
            {shownStatus === 'loading' && (
              <p className="gm-poi-wait" role="status">
                Writing an answer
                <span className="gm-poi-wait-line" aria-hidden="true" />
              </p>
            )}
            {shownStatus === 'ready' && (
              poi.details[shown]?.markdown
                ? <Markdown source={poi.details[shown]!.markdown!} />
                : <p className="gm-poi-wait">No answer was stored.</p>
            )}
            {shownStatus === 'error' && (
              <p className="gm-poi-wait">
                Could not get an answer.
                {requester && <button type="button" className="gm-poi-link" onClick={() => ask(shown)}>Try again</button>}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
