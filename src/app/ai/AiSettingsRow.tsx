// The "AI notes" row of the settings card: On / Off for the open map's repository. It shows the
// stored answer (the one the consent card and the prompt pill write), and changing it here is how
// AI is stopped after it was allowed, or allowed after "Not now". Rendered by ../settings.
import { useApp } from '../store';
import { Segmented, type SegmentedOption } from '../ui';
import { aiRow } from './rules';
import { switchAi } from './state';
import { useAiFacts } from './useAiFacts';
import './ai.css';

const CHOICES: SegmentedOption<'on' | 'off'>[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

/** Nothing is rendered when AI cannot apply to this map: turned off in config, a demo, no controller. */
export function AiSettingsRow() {
  const { session, controller, meta, consent } = useAiFacts();
  const progress = useApp((s) => s.progress.ai);
  if (!session) return null;
  const row = aiRow({ config: session.config, meta, available: controller.available, consent, progress });
  if (!row) return null;
  return (
    // a field like the rows around it, so it takes the same spacing
    <div className="gm-field gm-ai-setting">
      <Segmented label="AI notes" value={row.value} options={CHOICES} onChange={(to) => switchAi(session, controller, to)} />
      {/* always there, so that the words are announced when they appear */}
      <span className="gm-ai-setting-busy" role="status">{row.writing ? 'Writing…' : ''}</span>
      <p className="gm-ai-setting-note">For this repo</p>
    </div>
  );
}
