// The reader itself: header, tabs, and the body for whichever state the read is in.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ContentSource } from '../../contracts/git';
import type { Session } from '../../contracts/pipeline';
import { fileRef, type NodeRef, type RepoMeta } from '../../model/types';
import { setOpenFile } from '../store';
import { CloseIcon, PillButton, cx } from '../ui';
import { CodeView } from './CodeView';
import { decodeContent, formatBytes, type Decoded } from './content';
import { isMarkdown, type ReaderFile, type ReaderTarget } from './files';
import { MarkdownPreview } from './MarkdownPreview';
import { clampWidth, maxWidthFor, setMarkdownView, setWidth, usePrefs, type MarkdownView } from './prefs';
import { ResizeHandle } from './ResizeHandle';
import { SIDEBAR_LOCAL as T } from './tunables';

type ReadState =
  | { status: 'no-source' }
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'done'; content: Decoded };

/**
 * Read one file, once per open. A result that arrives after the user has moved on to another file
 * (or another map) is dropped.
 */
function useFileContent(session: Session | null, path: string): ReadState {
  // `content` is null for an imported map with no folder; it is read here, on every render, so the
  // reader notices when a folder is chosen later
  const source: ContentSource | null = session?.content ?? null;
  const available = source !== null;
  const [result, setResult] = useState<{ session: Session; path: string; state: ReadState } | null>(null);

  useEffect(() => {
    const from = session?.content;
    if (!session || !from) return;
    let current = true;
    const settle = (state: ReadState) => { if (current) setResult({ session, path, state }); };
    let reading: Promise<Uint8Array>;
    try { reading = from.read(fileRef(path)); } catch (err) { reading = Promise.reject(err); }
    reading.then(
      (bytes) => settle({ status: 'done', content: decodeContent(bytes, T.maxTextBytes, T.binarySniffBytes) }),
      () => settle({ status: 'failed' }),
    );
    return () => { current = false; };
  }, [session, path, available]);

  if (!available) return { status: 'no-source' };
  if (!result || result.session !== session || result.path !== path) return { status: 'loading' };
  return result.state;
}

function useViewportWidth(): number {
  const [width, setWidthNow] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidthNow(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

function Tabs({ files, active, panelId, onPick }: { files: ReaderFile[]; active: string; panelId: string; onPick: (path: string) => void }) {
  const row = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = files.findIndex((f) => f.path === active);
    const next =
      e.key === 'ArrowRight' ? (at + 1) % files.length
      : e.key === 'ArrowLeft' ? (at - 1 + files.length) % files.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? files.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    onPick(files[next]!.path);
    row.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div className="gm-reader-tabs" role="tablist" aria-label="Files of this unit" ref={row} onKeyDown={onKeyDown}>
      {files.map((f) => {
        const selected = f.path === active;
        return (
          <button
            key={f.path}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            title={f.path}
            className={cx('gm-reader-tab', selected && 'is-active')}
            onClick={() => onPick(f.path)}
          >
            {f.name}
          </button>
        );
      })}
    </div>
  );
}

const VIEWS: { value: MarkdownView; label: string }[] = [
  { value: 'preview', label: 'Preview' },
  { value: 'source', label: 'Source' },
];

/** Preview / Source: the shell's segmented control, without its caption, sized for the header. */
function ViewToggle({ value, onChange }: { value: MarkdownView; onChange: (v: MarkdownView) => void }) {
  const row = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = value === 'preview' ? 1 : 0;
    onChange(VIEWS[next]!.value);
    row.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div className="gm-segmented gm-reader-toggle" role="radiogroup" aria-label="Markdown view" ref={row} onKeyDown={onKeyDown}>
      {VIEWS.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={cx('gm-segment', checked && 'is-active')}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function lineLabel(lines: number): string {
  return `${lines.toLocaleString()} ${lines === 1 ? 'line' : 'lines'}`;
}

export interface ReaderProps {
  /** The store's `openFile`. */
  openFile: NodeRef;
  target: ReaderTarget;
  session: Session | null;
  meta: RepoMeta | null;
}

export function Reader({ openFile, target, session, meta }: ReaderProps) {
  const prefs = usePrefs();
  const viewport = useViewportWidth();
  const width = clampWidth(prefs.width, viewport);
  const panelId = useId();
  const root = useRef<HTMLElement>(null);

  // The tab the user picked, remembered only for the node it was picked on.
  const [picked, setPicked] = useState<{ ref: NodeRef; path: string } | null>(null);
  const file =
    (picked && picked.ref === openFile ? target.files.find((f) => f.path === picked.path) : undefined)
    ?? target.files[target.active]
    ?? target.files[0]!;

  const read = useFileContent(session, file.path);
  const text = read.status === 'done' && read.content.kind === 'text' ? read.content : null;

  // The language CodeMirror recognised, for files the model has no language name for.
  const [detected, setDetected] = useState<{ path: string; name: string } | null>(null);
  const markdown = isMarkdown(file.path);
  const language =
    meta?.languages?.[file.lang]?.name
    ?? (detected?.path === file.path ? detected.name : null)
    ?? (markdown ? 'Markdown' : null);
  // the real count once the text is here; the model's count until then, and for a file cut short
  const lines = text && !text.truncated ? text.lines : file.loc;
  const facts = [lines > 0 ? lineLabel(lines) : null, language].filter(Boolean).join(' · ');

  const showPreview = markdown && prefs.markdown === 'preview';

  // Opening the reader moves focus into it, so Escape closes it straight away; closing it gives
  // focus back to wherever it was.
  useEffect(() => {
    const el = root.current;
    const before = document.activeElement;
    el?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      const lost = now === null || now === document.body || (el?.contains(now) ?? false);
      if (lost && before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  const close = () => setOpenFile(null);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.stopPropagation();
    close();
  };

  let body: ReactNode;
  if (read.status === 'no-source') body = <p className="gm-reader-note">Choose the repo folder to view files</p>;
  else if (read.status === 'loading') body = <p className="gm-reader-note gm-reader-wait">Loading</p>;
  else if (read.status === 'failed') body = <p className="gm-reader-note">This file could not be read</p>;
  else if (!text) body = <p className="gm-reader-note">This file is not text</p>;
  else {
    const source = <CodeView key={file.path} text={text.text} fileName={file.name} onLanguage={(name) => setDetected({ path: file.path, name })} />;
    body = (
      <>
        {text.truncated && (
          <p className="gm-reader-strip">
            Showing the first {formatBytes(text.shownBytes)} of {formatBytes(text.totalBytes)}
          </p>
        )}
        {showPreview ? <MarkdownPreview key={file.path} text={text.text} fileName={file.name} fallback={source} /> : source}
      </>
    );
  }

  return (
    <aside
      className="gm-sidebar"
      ref={root}
      style={{ width }}
      tabIndex={-1}
      aria-label={`File reader: ${file.path}`}
      onKeyDown={onKeyDown}
    >
      <ResizeHandle
        width={width}
        min={T.widthMinPx}
        max={maxWidthFor(viewport)}
        onResize={(next, done) => setWidth(clampWidth(next, viewport), done)}
        onReset={() => setWidth(clampWidth(T.widthDefaultPx, viewport))}
      />
      <header className="gm-reader-head">
        <div className="gm-reader-title">
          <h2 className="gm-reader-heading" title={file.path}>
            <span className="gm-reader-name">{file.name}</span>
            {file.dir !== '' && <span className="gm-reader-dir">{file.dir}</span>}
          </h2>
          <PillButton round size="small" className="gm-reader-close" aria-label="Close the reader" title="Close (Esc)" onClick={close}>
            <CloseIcon size={14} />
          </PillButton>
        </div>
        {target.files.length > 1 && (
          <Tabs files={target.files} active={file.path} panelId={panelId} onPick={(path) => setPicked({ ref: openFile, path })} />
        )}
        {(facts !== '' || (markdown && text)) && (
          <div className="gm-reader-meta">
            <span className="gm-reader-facts">{facts}</span>
            {markdown && text && <ViewToggle value={prefs.markdown} onChange={setMarkdownView} />}
          </div>
        )}
      </header>
      <div
        className="gm-reader-body"
        id={panelId}
        role={target.files.length > 1 ? 'tabpanel' : undefined}
        aria-label={target.files.length > 1 ? file.name : undefined}
        aria-busy={read.status === 'loading'}
      >
        {body}
      </div>
    </aside>
  );
}
