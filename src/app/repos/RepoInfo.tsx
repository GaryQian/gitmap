// Under the title pill: a small pill saying where the open map is from, and the card it opens with
// the repo's details and "Export map" (PLAN.md §12, §12.1). Whatever a map does not have is left out.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { downloadModel } from '../../content';
import type { RepoMeta } from '../../model/types';
import { lineFor } from '../status/actions';
import { folderNeed, useFolderOffers } from '../status/folder';
import { folderRunners } from '../status/folderActions';
import { say } from '../status/messages';
import { useApp, useReplica, useSession } from '../store';
import { Card, PillButton, Strong } from '../ui';
import { whereLabel } from './registry';

const SHORT_OID = 10;
const count = (n: number): string => n.toLocaleString('en-US');

/** What the pill says: the same words as the landing page's repo pills. */
function sourceLabel(meta: RepoMeta): string {
  switch (meta.source) {
    case 'demo': return 'Demo';
    case 'import': return meta.remoteUrl ?? 'imported map';
    case 'synthetic': return 'synthetic map';
    default: return whereLabel(meta.remoteUrl);
  }
}

/** An http(s) address to link to, or null. A map file can come from anyone, so nothing else becomes a link. */
function webUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  // a normalised remote has no scheme: "github.com/facebook/react"
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(value) ? `https://${value}` : null;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function Address({ value }: { value: string }) {
  const href = webUrl(value);
  const shown = value.replace(/^https?:\/\//i, '');
  return href ? <a className="gm-repo-link" href={href} target="_blank" rel="noreferrer noopener">{shown}</a> : <>{shown}</>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function InfoIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9.2" />
      <path d="M12 11v6" />
      <path d="M12 7.4v.2" />
    </svg>
  );
}

function ExportButton() {
  const session = useSession();
  const [state, setState] = useState<'idle' | 'busy' | 'unavailable'>('idle');
  if (!session) return null;
  // a map that cannot be exported loses the button instead of keeping a dead one
  if (state === 'unavailable') return <p className="gm-repo-note" role="status">{say('export-failed').text}</p>;
  const run = async (): Promise<void> => {
    setState('busy');
    try {
      await downloadModel(await session.exportModel());
      setState('idle');
    } catch (err) {
      console.warn('starmap: export failed', err);
      if (useApp.getState().session === session) setState('unavailable');
    }
  };
  return (
    <PillButton size="small" className="gm-repo-export" disabled={state === 'busy'} onClick={() => void run()}>
      {state === 'busy' ? 'Preparing the file' : 'Export map'}
    </PillButton>
  );
}

/**
 * A map opened without its folder (an imported map, a saved one whose folder needs asking for
 * again): what is unavailable meanwhile, and the one action that brings the folder back.
 */
function FolderNote({ meta }: { meta: RepoMeta }) {
  const session = useSession();
  useFolderOffers();
  const [busy, setBusy] = useState(false);
  const need = folderNeed(session, meta);
  if (!need) return null;
  const { text, action } = lineFor(need.status, {}, folderRunners);
  const run = async (): Promise<void> => {
    if (!action) return;
    setBusy(true);
    try { await action.run(); } catch (err) { console.warn(`starmap: "${action.label}" failed`, err); }
    setBusy(false);
  };
  return (
    <div className="gm-repo-folder">
      <p className="gm-repo-note">{text}</p>
      {action && <PillButton size="small" disabled={busy} onClick={() => void run()}>{action.label}</PillButton>}
    </div>
  );
}

export function RepoInfo() {
  const meta = useReplica()?.meta ?? null;
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    // capture: the map canvas takes pointer events for itself
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!meta) return null;
  const { stats, demo } = meta;
  // a demo's commit is its head commit: say it once
  const commit = demo?.commit || meta.headOid;
  const source = demo?.sourceUrl || null;
  // the origin is worth its own row unless the source row already says the same thing
  const origin = meta.remoteUrl && webUrl(meta.remoteUrl) !== webUrl(source) ? meta.remoteUrl : null;

  return (
    <div className="gm-repo-info" ref={wrap}>
      <PillButton
        ref={button}
        size="small"
        blur
        active={open}
        className="gm-repo-info-pill"
        aria-label={`About this map: ${sourceLabel(meta)}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="About this map"
        onClick={() => setOpen((o) => !o)}
      >
        <InfoIcon />
        <span className="gm-repo-where">{sourceLabel(meta)}</span>
      </PillButton>
      {open && (
        <Card blur className="gm-repo-card" role="dialog" aria-label="About this map">
          <p className="gm-repo-name"><Strong>{meta.name}</Strong></p>
          <dl className="gm-repo-facts">
            {origin && <Row label="Origin"><Address value={origin} /></Row>}
            {source && <Row label="Source"><Address value={source} /></Row>}
            {stats.files > 0 && <Row label="Files">{count(stats.files)}</Row>}
            {stats.loc > 0 && <Row label="Lines">{count(stats.loc)}</Row>}
            {commit && <Row label="Commit"><span title={commit}>{commit.slice(0, SHORT_OID)}</span></Row>}
            {demo?.license && <Row label="Licence">{demo.license}</Row>}
          </dl>
          <FolderNote meta={meta} />
          <ExportButton />
        </Card>
      )}
    </div>
  );
}
