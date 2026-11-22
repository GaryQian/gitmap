// The reader and editor: header, tabs, and the body for whichever state the read is in. Edits are
// kept per file in drafts.ts until saved: to the folder when the browser can write to it, otherwise
// as a download.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ContentSource } from '../../contracts/git';
import type { Session } from '../../contracts/pipeline';
import { fileRef, type NodeRef, type RepoMeta } from '../../model/types';
import { LAYER, useDismissable } from '../keys';
import { setOpenFile } from '../store';
import { CloseIcon, PillButton, cx } from '../ui';
import { CodeView } from './CodeView';
import { countLines, decodeContent, encodeContent, formatBytes, type Decoded } from './content';
import { discardDraft, isDirty, setBase, setDraft, setEmptyOpen, useEdits } from './drafts';
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

function Tabs({ files, active, panelId, dirty, onPick }: {
  files: ReaderFile[]; active: string; panelId: string; dirty: (path: string) => boolean; onPick: (path: string) => void;
}) {
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
            {dirty(f.path) && <span className="gm-reader-dirty" role="img" aria-label="unsaved changes" />}
          </button>
        );
      })}
    </div>
  );
}

const VIEWS: { value: MarkdownView; label: string }[] = [
  { value: 'preview', label: 'Preview' },
  { value: 'split', label: 'Split' },
  { value: 'source', label: 'Source' },
];

/** Preview / Split / Source: the shell's segmented control, without its caption, sized for the header. */
function ViewToggle({ value, onChange }: { value: MarkdownView; onChange: (v: MarkdownView) => void }) {
  const row = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (VIEWS.findIndex((o) => o.value === value) + step + VIEWS.length) % VIEWS.length;
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

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; how: 'disk' | 'download' }
  | { status: 'failed'; message: string };

/** Hand the text to the browser as a download: for a source the page cannot write back to. */
function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const isSaveKey = (e: KeyboardEvent<HTMLElement>) =>
  (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's';

/**
 * The panel itself, whatever is in it: width, resize handle, focus on open and back on close, and
 * Escape to close.
 */
function Panel({ label, onClose, onKeyDown, children }: {
  label: string; onClose: () => void; onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void; children: ReactNode;
}) {
  const prefs = usePrefs();
  const viewport = useViewportWidth();
  const width = clampWidth(prefs.width, viewport);
  const root = useRef<HTMLElement>(null);

  // Opening the panel moves focus into it, so Escape closes it straight away; closing it gives
  // focus back to wherever it was.
  useEffect(() => {
    const el = root.current;
    const before = document.activeElement;
    el?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      const lost = now === null || now === document.body || (el?.contains(now) ?? false);
      if (!lost) return;
      // the button that reopened the panel was replaced while it was open: the new one is the way back in
      const back = before instanceof HTMLElement && before.isConnected ? before : document.querySelector<HTMLElement>('.gm-reader-reopen');
      back?.focus({ preventScroll: true });
    };
  }, []);

  // Escape closes the panel in its turn: after any card, list or tour, before the selection (keys.ts).
  // Typed in the editor, the key is the panel's unless the editor used it (to close its search bar).
  useDismissable(true, onClose, { layer: LAYER.sidebar, owns: (field) => root.current?.contains(field as Node) ?? false });

  return (
    <aside className="gm-sidebar" ref={root} style={{ width }} tabIndex={-1} aria-label={label} onKeyDown={onKeyDown}>
      <ResizeHandle
        width={width}
        min={T.widthMinPx}
        max={maxWidthFor(viewport)}
        onResize={(next, done) => setWidth(clampWidth(next, viewport), done)}
        onReset={() => setWidth(clampWidth(T.widthDefaultPx, viewport))}
      />
      {children}
    </aside>
  );
}

/** The panel reopened before any file was: how to put one in it. */
export function EmptyReader() {
  const close = () => setEmptyOpen(false);
  return (
    <Panel label="File panel" onClose={close}>
      <header className="gm-reader-head">
        <div className="gm-reader-title">
          <h2 className="gm-reader-heading"><span className="gm-reader-name">No file open</span></h2>
          <PillButton round size="small" className="gm-reader-close" aria-label="Close the panel" title="Close (Esc)" onClick={close}>
            <CloseIcon size={14} />
          </PillButton>
        </div>
      </header>
      <div className="gm-reader-body">
        <p className="gm-reader-note">Double-click a sphere to open its file here</p>
      </div>
    </Panel>
  );
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
  const edits = useEdits();
  const panelId = useId();

  // The tab the user picked, remembered only for the node it was picked on.
  const [picked, setPicked] = useState<{ ref: NodeRef; path: string } | null>(null);
  const file =
    (picked && picked.ref === openFile ? target.files.find((f) => f.path === picked.path) : undefined)
    ?? target.files[target.active]
    ?? target.files[0]!;

  const read = useFileContent(session, file.path);
  const text = read.status === 'done' && read.content.kind === 'text' ? read.content : null;

  // What was read is what is on disk; an unsaved draft of the file is kept beside it.
  useEffect(() => { if (text) setBase(file.path, text.text); }, [text, file.path]);
  const current = edits.drafts[file.path] ?? edits.base[file.path] ?? text?.text ?? '';
  const dirty = isDirty(edits, file.path);
  // a file cut short, or one with bytes that are not UTF-8, would be damaged by saving it
  const readOnly = !text || text.truncated || text.lossy;
  const content = session?.content ?? null;
  const canWrite = typeof content?.write === 'function';

  // Bumped to throw away the editor's own text (after Revert).
  const [revision, setRevision] = useState(0);
  const [save, setSave] = useState<SaveState>({ status: 'idle' });
  useEffect(() => { setSave({ status: 'idle' }); }, [file.path]);
  // "Saved" goes as soon as there is something new to save
  useEffect(() => { if (dirty) setSave((s) => (s.status === 'saved' ? { status: 'idle' } : s)); }, [dirty]);

  // The language CodeMirror recognised, for files the model has no language name for.
  const [detected, setDetected] = useState<{ path: string; name: string } | null>(null);
  const markdown = isMarkdown(file.path);
  const language =
    meta?.languages?.[file.lang]?.name
    ?? (detected?.path === file.path ? detected.name : null)
    ?? (markdown ? 'Markdown' : null);
  // the real count once the text is here; the model's count until then, and for a file cut short
  const lines = text && !text.truncated ? countLines(current) : file.loc;
  const facts = [lines > 0 ? lineLabel(lines) : null, language, text && readOnly ? 'Read-only' : null].filter(Boolean).join(' · ');

  const view: MarkdownView = markdown ? prefs.markdown : 'source';

  const close = () => setOpenFile(null);

  const doSave = async () => {
    if (!text || readOnly) return;
    const path = file.path;
    const now = useEdits.getState();
    if (!isDirty(now, path)) return;
    const body = now.drafts[path]!;
    const bytes = encodeContent(body, text.bom);
    if (!content?.write) {
      download(file.name, bytes);
      setBase(path, body);
      setSave({ status: 'saved', how: 'download' });
      return;
    }
    setSave({ status: 'saving' });
    try {
      await content.write(fileRef(path), bytes);
      setBase(path, body);
      setSave({ status: 'saved', how: 'disk' });
    } catch (err) {
      setSave({ status: 'failed', message: err instanceof Error ? err.message : 'Could not save the file.' });
    }
  };

  const revert = () => {
    discardDraft(file.path);
    setRevision((r) => r + 1);
    setSave({ status: 'idle' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!isSaveKey(e)) return;
    e.preventDefault();
    void doSave();
  };

  let body: ReactNode;
  if (read.status === 'no-source') body = <p className="gm-reader-note">Choose the repo folder to view files</p>;
  else if (read.status === 'loading') body = <p className="gm-reader-note gm-reader-wait">Loading</p>;
  else if (read.status === 'failed') body = <p className="gm-reader-note">This file could not be read</p>;
  else if (!text) body = <p className="gm-reader-note">This file is not text</p>;
  else {
    const source = (
      <CodeView
        key={`${file.path}#${revision}`}
        text={current}
        fileName={file.name}
        readOnly={readOnly}
        onChange={(t) => setDraft(file.path, t)}
        onSave={() => void doSave()}
        onLanguage={(name) => setDetected({ path: file.path, name })}
      />
    );
    const preview = (fallback: ReactNode) => (
      <MarkdownPreview key={file.path} text={current} fileName={file.name} fallback={fallback} />
    );
    body = (
      <>
        {text.truncated && (
          <p className="gm-reader-strip">
            Showing the first {formatBytes(text.shownBytes)} of {formatBytes(text.totalBytes)} · read-only
          </p>
        )}
        {!text.truncated && text.lossy && (
          <p className="gm-reader-strip">Some bytes are not UTF-8, so this file is read-only</p>
        )}
        {view === 'preview' ? preview(source)
          : view === 'split' ? (
            <div className="gm-reader-split">
              {source}
              <div className="gm-reader-split-preview">{preview(null)}</div>
            </div>
          )
          : source}
      </>
    );
  }

  const status =
    save.status === 'saving' ? 'Saving'
    : save.status === 'saved' ? (save.how === 'disk' ? 'Saved' : 'Downloaded')
    : save.status === 'failed' ? save.message
    : null;

  return (
    <Panel label={`File editor: ${file.path}`} onClose={close} onKeyDown={onKeyDown}>
      <header className="gm-reader-head">
        <div className="gm-reader-title">
          <h2 className="gm-reader-heading" title={file.path}>
            <span className="gm-reader-name">{file.name}</span>
            {dirty && <span className="gm-reader-dirty" role="img" aria-label="unsaved changes" />}
            {file.dir !== '' && <span className="gm-reader-dir">{file.dir}</span>}
          </h2>
          {dirty && (
            <>
              <PillButton size="small" className="gm-reader-action" onClick={revert} title="Discard unsaved changes">
                Revert
              </PillButton>
              <PillButton
                size="small"
                className="gm-reader-action gm-reader-save"
                onClick={() => void doSave()}
                disabled={save.status === 'saving'}
                title={canWrite ? 'Save to disk (Ctrl+S)' : 'The browser cannot write to this folder: download the file instead (Ctrl+S)'}
              >
                {canWrite ? 'Save' : 'Download'}
              </PillButton>
            </>
          )}
          <PillButton round size="small" className="gm-reader-close" aria-label="Close the panel" title="Close (Esc)" onClick={close}>
            <CloseIcon size={14} />
          </PillButton>
        </div>
        {target.files.length > 1 && (
          <Tabs
            files={target.files}
            active={file.path}
            panelId={panelId}
            dirty={(path) => isDirty(edits, path)}
            onPick={(path) => setPicked({ ref: openFile, path })}
          />
        )}
        {(facts !== '' || (markdown && text) || status) && (
          <div className="gm-reader-meta">
            <span className="gm-reader-facts">{facts}</span>
            {status && (
              <span className={cx('gm-reader-status', save.status === 'failed' && 'is-error')} role={save.status === 'failed' ? 'alert' : 'status'}>{status}</span>
            )}
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
    </Panel>
  );
}
