// Landing page repo pills (PLAN.md §17.7, plan/DEMO-MODE.md §5–§6): saved repos and demos together,
// most recently opened first; a demo carries a "Demo" tag. Each shows the repo's name and where it is
// from; clicking one opens it. A saved repo also has a small × that deletes what was saved for it,
// after a confirmation dialog; demos have none.
import { useEffect, useId, useRef, useState } from 'react';
import { config, type DemoRepo } from '../../config';
import { openSource } from '../session';
import { lineFor } from '../status/actions';
import { offerFolder } from '../status/folder';
import { setMessage } from '../store';
import { CloseIcon, PillButton, Strong } from '../ui';
import { DemoTag } from './DemoTag';
import { demosOpened, markDemoOpened, orderPills } from './demos';
import { NO_SAVED_REPOS, savedRepos, whereLabel, type SavedOpen, type SavedRepo, type SavedRepos } from './registry';

/** Saved repos shown. The page is one button and a few pills, not a list to scroll. */
const MAX_SAVED = 8;

/** A demo's package: `/demo/<name>.starmap.zip` is relative to where the app is served, which is not always the origin's root. */
export function demoUrl(repo: DemoRepo): string {
  const base = import.meta.env.BASE_URL ?? '/';
  const { file } = repo;
  return file.startsWith('/') && !file.startsWith('//') ? base.replace(/\/$/, '') + file : file;
}

/** `demo`: the pill carries the "Demo" tag and is named "<name>, demo", so it is told apart from a saved repo of the same name. */
function RepoPill({ name, where, title, demo, onOpen }: { name: string; where?: string; title?: string; demo?: boolean; onOpen(): void }) {
  return (
    <PillButton className="gm-repo-pill" title={title} aria-label={demo ? `${name}, demo` : undefined} onClick={onOpen}>
      <Strong>{name}</Strong>
      {where && <span className="gm-repo-where">{where}</span>}
      {demo && <DemoTag />}
    </PillButton>
  );
}

/**
 * "Delete <name>?" as a modal dialog: the browser's own <dialog>, so focus stays inside it, Escape
 * cancels and the page behind cannot be clicked.
 */
function ConfirmDelete({ repo, onCancel, onConfirm }: { repo: SavedRepo; onCancel(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const textId = useId();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => { if (d?.open) d.close(); };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="gm-card gm-blur gm-repo-dialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      // Escape: the browser closes the dialog; tell the page
      onCancel={(e) => { e.preventDefault(); if (!busy) onCancel(); }}
      // a click on the backdrop (the dialog element itself, outside its content) cancels too
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
      <h2 className="gm-repo-dialog-title" id={titleId}>Delete {repo.name}?</h2>
      <p className="gm-repo-dialog-text" id={textId}>
        Removes the saved map, its history and its place in this list. The folder and its files are not touched;
        choosing the folder again maps it from scratch.
      </p>
      <div className="gm-repo-dialog-actions">
        <PillButton size="small" onClick={onCancel} disabled={busy} autoFocus>Cancel</PillButton>
        <PillButton
          size="small"
          className="gm-repo-dialog-delete"
          disabled={busy}
          onClick={() => { setBusy(true); onConfirm(); }}
        >
          Delete
        </PillButton>
      </div>
    </dialog>
  );
}

export function RepoPills() {
  const [saved, setSaved] = useState<SavedRepo[]>([]);
  const [deleting, setDeleting] = useState<SavedRepo | null>(null);
  const registry = useRef<SavedRepos>(NO_SAVED_REPOS);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  // when each demo was last opened here: demos take their place among the saved repos by it
  const [demoOpened] = useState(() => demosOpened());

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const found = await savedRepos();
        const list = await found.listSaved();
        if (!live) return;
        registry.current = found;
        setSaved(list.slice(0, MAX_SAVED));
      } catch (err) {
        // the page still works without the list: a folder can be chosen, a demo opened
        console.warn('starmap: could not list saved repos', err);
      }
    })();
    return () => { live = false; };
  }, []);

  const remove = async (repo: SavedRepo): Promise<void> => {
    try {
      await registry.current.removeSaved(repo.id);
    } catch (err) {
      console.warn('starmap: the saved map could not be removed', err);
    }
    setSaved((list) => list.filter((r) => r.id !== repo.id));
    setMessage(null);
  };

  const openSaved = async (repo: SavedRepo): Promise<void> => {
    setMessage(null);
    let opened: SavedOpen | null = null;
    try {
      opened = await registry.current.openSaved(repo.id); // called in the click: it may ask for folder permission
    } catch (err) {
      console.warn('starmap: the saved map could not be opened', err);
    }
    if (opened) {
      // a map that opens without its folder says what the folder needs once it is on screen
      if (opened.folder) offerFolder(opened.source, opened.folder);
      await openSource(opened.source);
      return;
    }
    // Neither a usable snapshot nor a readable folder: say so, and offer to drop the entry. Choosing
    // the folder with the button above maps it again and renews the entry.
    const line = lineFor('saved-map-gone', { name: repo.name }, { 'remove-saved': () => remove(repo) });
    setMessage(line.text, line.action);
  };

  const openDemo = (repo: DemoRepo): void => {
    setMessage(null);
    markDemoOpened(repo.name); // its pill comes first on the next visit to this page
    void openSource({ kind: 'demo', name: repo.name, url: demoUrl(repo) });
  };

  const cancelDelete = () => {
    const repo = deleting;
    setDeleting(null);
    // focus goes back to the × that opened the dialog
    if (repo) requestAnimationFrame(() => deleteButtons.current.get(repo.id)?.focus());
  };

  return (
    <>
      {orderPills(saved, config.demo.repos, demoOpened).map((item) => {
        if (item.kind === 'demo') {
          const demo = item.repo;
          return <RepoPill key={item.key} demo name={demo.name} where={demo.location} title={demo.location} onOpen={() => openDemo(demo)} />;
        }
        const { repo } = item;
        return (
        <div key={item.key} className="gm-repo-saved">
          <RepoPill name={repo.name} where={whereLabel(repo.remoteUrl)} onOpen={() => void openSaved(repo)} />
          {/* inside the pill's right end, shown after half a second of hovering (or at once on keyboard focus) */}
          <button
            type="button"
            className="gm-repo-delete"
            aria-label={`Delete ${repo.name}`}
            title={`Delete ${repo.name}`}
            ref={(el) => { if (el) deleteButtons.current.set(repo.id, el); else deleteButtons.current.delete(repo.id); }}
            onClick={() => setDeleting(repo)}
          >
            <CloseIcon size={12} />
          </button>
        </div>
        );
      })}
      {deleting && (
        <ConfirmDelete
          key={deleting.id}
          repo={deleting}
          onCancel={cancelDelete}
          onConfirm={() => {
            const repo = deleting;
            void remove(repo).finally(() => setDeleting(null));
          }}
        />
      )}
    </>
  );
}
