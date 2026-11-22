// The "Export" row of the settings card (plan/DEMO-MODE.md §3). Two choices: "Map and files" writes
// the package (`<name>.starmap.zip`: the map, its AI notes and the text of its files), after one
// confirmation; "Map only" downloads the `.starmap.json.gz` with no file contents. The work itself
// is in exportMap.ts. A run belongs to the open map, not to the card: closing the card leaves it
// running, and opening the card again shows where it is.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { downloadModel, packageFileName } from '../../content';
import type { Session } from '../../contracts/pipeline';
import { getAiConsent, type AiController } from '../ai';
import { aiCanRun } from '../ai/rules';
import { useAiFacts } from '../ai/useAiFacts';
import { say } from '../status/messages';
import { useApp, usePhase } from '../store';
import { PillButton, Strong } from '../ui';
import {
  chooseTarget, downloadUrl, exportPackage, fileNameOfUrl, incompleteNotes, isAbort, resultLines, type ExportResult,
} from './exportMap';

type ExportState =
  | { at: 'idle' }
  | { at: 'confirm' }
  | { at: 'running'; line: string }
  | { at: 'done'; result: ExportResult }
  | { at: 'failed' };

const IDLE: ExportState = { at: 'idle' };
const useExport = create<ExportState>()(() => IDLE);
const show = (state: ExportState): void => useExport.setState(state, true);

/** The run in flight, if any: whose map it is, and how to stop it. */
let running: { session: Session; abort: AbortController } | null = null;

/** How often the progress line is redrawn while files are packed. */
const STATUS_MS = 120;

/** Stop the run in flight, if any, and go back to the two buttons. */
function cancelExport(): void {
  running?.abort.abort();
  running = null;
  show(IDLE);
}

/**
 * Write the package of the open map. Call it from the click: the save dialog opens first, and the
 * browser allows that only while the click is still being handled. `ai` is null to export without
 * finishing the AI work.
 */
async function startExport(session: Session, ai: AiController | null): Promise<void> {
  const meta = session.replica.meta;
  if (!meta || running) return;
  const mine = { session, abort: new AbortController() };
  running = mine;
  const current = (): boolean => running === mine;
  const repoId = meta.id;

  // at most one redraw per STATUS_MS; the latest line always gets shown
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    timer = null;
    if (pending !== null && current()) show({ at: 'running', line: pending });
    pending = null;
  };
  const status = (line: string): void => {
    pending = line;
    timer ??= setTimeout(flush, STATUS_MS);
  };

  show({ at: 'running', line: 'Choose where to save the package' });
  try {
    const target = await chooseTarget(packageFileName({ meta }));
    if (!target) { if (current()) cancelExport(); return; } // the dialog was closed: nothing happened
    if (!current()) { try { await target.sink.abort?.(); } catch { /* nothing was written */ } return; }
    const result = await exportPackage({
      session,
      target,
      ai,
      aiAllowed: () => getAiConsent(repoId) === 'granted',
      onStatus: status,
      signal: mine.abort.signal,
    });
    if (current()) show({ at: 'done', result });
  } catch (err) {
    if (!current()) return; // cancelled, or the map was closed
    if (isAbort(err)) { show(IDLE); return; }
    console.warn('starmap: the package could not be exported', err);
    show({ at: 'failed' });
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (current()) running = null;
  }
}

// A run, a confirmation or a result is about one map: it does not follow the viewer to the next.
useApp.subscribe((state, before) => {
  if (state.session !== before.session) cancelExport();
});

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (err) {
      // the line is on screen and can be selected by hand
      console.warn('starmap: the line could not be copied', err);
    }
  };
  return <PillButton size="small" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy line'}</PillButton>;
}

export function ExportRow() {
  const phase = usePhase();
  const { session, replica, controller, meta, consent } = useAiFacts();
  const state = useExport();
  const hasNotes = (replica?.annotations.length ?? 0) > 0;
  const [mapOnly, setMapOnly] = useState<'idle' | 'busy' | 'failed'>('idle');
  useEffect(() => { setMapOnly('idle'); }, [session]);

  const revealed = phase === 'map' && session !== null && meta !== null;
  const demo = revealed && session.source.kind === 'demo' ? session.source : null;
  // a package holds the files the map was built from: only a map with its folder can write one
  const packable = revealed && typeof session.readFiles === 'function' && meta.source !== 'demo' && meta.source !== 'import';
  const withAi = packable && consent === 'granted' && aiCanRun({ config: session.config, meta, available: controller.available });

  const exportMapOnly = async (): Promise<void> => {
    if (!session) return;
    setMapOnly('busy');
    try {
      await downloadModel(await session.exportModel());
      if (useApp.getState().session === session) setMapOnly('idle');
    } catch (err) {
      console.warn('starmap: export failed', err);
      if (useApp.getState().session === session) setMapOnly('failed');
    }
  };

  const packageTitle =
    !revealed ? 'Available once the map is on screen'
    : demo ? 'Download the package this demo was opened from'
    : !packable ? 'Needs a map opened from a folder: the package holds its files'
    : 'Save the map, its AI notes and its files as one package (.starmap.zip)';

  let body;
  if (state.at === 'confirm' && packable) {
    const notes = incompleteNotes(meta);
    body = (
      <div className="gm-export-confirm" role="group" aria-label="Confirm export">
        <p className="gm-export-note">
          {withAi ? (
            <>Finishes the AI notes for <Strong>{meta.name}</Strong>, including every detail card, then saves the map and its files as one package.</>
          ) : (
            <>
              Saves the map of <Strong>{meta.name}</Strong> and its files as one package.{' '}
              {hasNotes
                ? 'AI notes are off for this repo, so no more will be written: the package keeps only the ones the map already has.'
                : 'AI notes are off for this repo, so the package will be exported without AI summaries.'}
            </>
          )}
        </p>
        {notes.map((note) => <p key={note} className="gm-export-note">{note}</p>)}
        <div className="gm-export-actions">
          <PillButton size="small" onClick={cancelExport}>Cancel</PillButton>
          <PillButton size="small" className="gm-export-go" onClick={() => void startExport(session, withAi ? controller : null)}>
            {withAi ? 'Export' : 'Export without AI'}
          </PillButton>
        </div>
      </div>
    );
  } else if (state.at === 'running') {
    body = (
      <div className="gm-export-confirm" role="group" aria-label="Exporting">
        <p className="gm-export-note gm-export-progress">{state.line}</p>
        <div className="gm-export-actions">
          <PillButton size="small" onClick={cancelExport}>Cancel</PillButton>
        </div>
      </div>
    );
  } else if (state.at === 'done') {
    body = (
      <div className="gm-export-confirm" role="group" aria-label="Export finished">
        <div role="status">
          {resultLines(state.result).map((line) => <p key={line} className="gm-export-note">{line}</p>)}
        </div>
        <p className="gm-export-note">Line for config.json</p>
        <code className="gm-code gm-export-config">{state.result.configLine}</code>
        <div className="gm-export-actions">
          <CopyLine text={state.result.configLine} />
          <PillButton size="small" onClick={() => show(IDLE)}>Done</PillButton>
        </div>
      </div>
    );
  } else if (state.at === 'failed') {
    body = (
      <div className="gm-export-confirm" role="group" aria-label="Export failed">
        <p className="gm-export-note" role="alert">The package could not be exported.</p>
        <div className="gm-export-actions">
          <PillButton size="small" onClick={() => show(IDLE)}>Close</PillButton>
        </div>
      </div>
    );
  } else {
    body = (
      <>
        <div className="gm-export-choices">
          <PillButton
            size="small"
            className="gm-export-button"
            disabled={!demo && !packable}
            title={packageTitle}
            onClick={() => {
              if (demo) downloadUrl(demo.url, fileNameOfUrl(demo.url));
              else show({ at: 'confirm' });
            }}
          >
            Map and files
          </PillButton>
          <PillButton
            size="small"
            className="gm-export-button"
            disabled={!revealed || mapOnly === 'busy'}
            title={revealed ? 'Save the map alone, without its files (.starmap.json.gz)' : 'Available once the map is on screen'}
            onClick={() => void exportMapOnly()}
          >
            {mapOnly === 'busy' ? 'Preparing the file' : 'Map only'}
          </PillButton>
        </div>
        {mapOnly === 'failed' && <p className="gm-export-note" role="status">{say('export-failed').text}</p>}
      </>
    );
  }

  return (
    <div className="gm-field gm-export">
      <div className="gm-field-label">Export</div>
      {body}
    </div>
  );
}
