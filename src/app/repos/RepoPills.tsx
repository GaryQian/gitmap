// Landing page repo pills (PLAN.md §17.7, plan/DEMO-MODE.md §5–§6): saved repos and demos together,
// most recently opened first; a demo carries a "Demo" tag. Each shows the repo's name and where it is
// from; clicking one opens it. A saved repo also has a small × that deletes what was saved for it,
// after a confirmation dialog; demos have none.
//
// First in the row is a small search pill. Clicking it (or typing in it) opens the search: the pill
// widens into a field and moves to the middle on a line of its own, every repo pill goes away, and
// the repos that match what is typed appear beneath it. Clicking anywhere else, or Escape, closes it.
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { config, type DemoRepo } from '../../config';
import { LAYER, useDismissable } from '../keys';
import { openSource } from '../session';
import { lineFor } from '../status/actions';
import { offerFolder } from '../status/folder';
import { setMessage } from '../store';
import { CloseIcon, Pill, PillButton, SearchIcon, Strong, cx } from '../ui';
import { DemoTag } from './DemoTag';
import { demosOpened, markDemoOpened, orderPills, type RepoPillItem } from './demos';
import { findRepos } from './find';
import { NO_SAVED_REPOS, savedRepos, whereLabel, type SavedOpen, type SavedRepo, type SavedRepos } from './registry';
import { uiScale } from '../uiScale';

/** Saved repos shown. The page is one button and a few pills, not a list to scroll. The search reaches the rest. */
const MAX_SAVED = 8;
/** Matches shown under the search field. */
const MAX_FOUND = 12;
/** How long the search pill takes to travel between its place in the row and the middle. */
const SEARCH_MOVE_MS = 220;
/** When to read the saved list again after the landing page appears: a map just closed may still be saving. */
const RELIST_AFTER_MS = [1200, 3500, 8000];

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
      <span className="gm-repo-pill-text">
        <Strong>{name}</Strong>
        {where && <span className="gm-repo-where">{where}</span>}
      </span>
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

/**
 * The search pill. Closed, it reads "Search" and is as small as its label; open, it is a field.
 * Focus alone does not open it, so tabbing across the page leaves the pills where they are: a press
 * on the pill or a typed letter does.
 */
function SearchField({ open, query, pill, input, onOpen, onQuery, onEnter }: {
  open: boolean;
  query: string;
  pill: RefObject<HTMLDivElement | null>;
  input: RefObject<HTMLInputElement | null>;
  onOpen(): void;
  onQuery(query: string): void;
  onEnter(): void;
}) {
  return (
    <div className="gm-repo-search-slot">
      <Pill
        ref={pill}
        className={cx('gm-repo-search', open && 'is-open')}
        title={open ? undefined : 'Search repos'}
        onMouseDown={(e) => {
          onOpen();
          if (e.target === input.current) return;
          e.preventDefault(); // a press on the icon or the padding must not take the focus away again
          input.current?.focus();
        }}
      >
        <SearchIcon />
        <input
          ref={input}
          className="gm-repo-search-input"
          type="text"
          role="searchbox"
          aria-label="Search repos"
          placeholder={open ? 'Search repos' : 'Search'}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => { onOpen(); onQuery(e.target.value); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') { e.preventDefault(); if (open) onEnter(); else onOpen(); }
            else if (e.key === 'ArrowDown' && !open) { e.preventDefault(); onOpen(); }
          }}
        />
      </Pill>
    </div>
  );
}

export function RepoPills() {
  const [saved, setSaved] = useState<SavedRepo[]>([]);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  /** The height of the pills when the search opened: held while it is open, so the page above does not move. */
  const [held, setHeld] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const searchPill = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  /** Where the middle of the search pill was before the search opened or closed: it travels from there. */
  const movedFrom = useRef<{ x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState<SavedRepo | null>(null);
  const registry = useRef<SavedRepos>(NO_SAVED_REPOS);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  // when each demo was last opened here: demos take their place among the saved repos by it
  const [demoOpened] = useState(() => demosOpened());

  useEffect(() => {
    let live = true;
    const load = async (): Promise<void> => {
      try {
        const found = await savedRepos();
        const list = await found.listSaved();
        if (!live) return;
        registry.current = found;
        // keep the same array when nothing changed, so a re-read does not re-render the pills
        setSaved((shown) => (shown.length === list.length && shown.every((r, i) => r.id === list[i].id && r.lastOpened === list[i].lastOpened) ? shown : list));
      } catch (err) {
        // the page still works without the list: a folder can be chosen, a demo opened
        console.warn('starmap: could not list saved repos', err);
      }
    };
    void load();
    // The landing page appears the moment a map is closed, while that map's last save may still be
    // on its way to storage. Read the list again shortly after, so the repo just closed shows up
    // without a reload; and again when the tab comes back, in case another tab saved one.
    const later = RELIST_AFTER_MS.map((ms) => setTimeout(() => void load(), ms));
    const onVisible = (): void => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      for (const t of later) clearTimeout(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
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

  const middleOfSearch = (): { x: number; y: number } | null => {
    const r = searchPill.current?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  };

  const openSearch = (): void => {
    if (searching) return;
    movedFrom.current = middleOfSearch();
    setHeld(root.current?.offsetHeight ?? null);
    setSearching(true);
  };

  const closeSearch = (): void => {
    movedFrom.current = middleOfSearch();
    setSearching(false);
    setQuery('');
    setHeld(null);
  };

  // The pill does not jump between its place in the row and the middle: it travels there.
  useLayoutEffect(() => {
    const from = movedFrom.current;
    movedFrom.current = null;
    const el = searchPill.current;
    if (!from || !el || typeof el.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const r = el.getBoundingClientRect();
    // measured in window pixels; the landing page is zoomed by the chrome's scale (uiScale.ts)
    const z = uiScale();
    const dx = (from.x - (r.left + r.width / 2)) / z, dy = (from.y - (r.top + r.height / 2)) / z;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    const easing = getComputedStyle(el).getPropertyValue('--gm-ease').trim() || 'ease';
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: SEARCH_MOVE_MS, easing });
  }, [searching]);

  // A press anywhere but the field, a repo pill or the delete dialog closes the search.
  useEffect(() => {
    if (!searching) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('.gm-repo-search, .gm-repo-pill, .gm-repo-delete, .gm-repo-dialog')) return;
      closeSearch();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [searching]);

  // Escape closes it too; the delete dialog, when open, takes the key for itself.
  useDismissable(searching, () => { if (!deleting) closeSearch(); }, { layer: LAYER.list, owns: (field) => field === searchInput.current });

  const open = (item: RepoPillItem): void => {
    if (item.kind === 'demo') openDemo(item.repo); else void openSaved(item.repo);
  };

  const cancelDelete = () => {
    const repo = deleting;
    setDeleting(null);
    // focus goes back to the × that opened the dialog
    if (repo) requestAnimationFrame(() => deleteButtons.current.get(repo.id)?.focus());
  };

  const shown = orderPills(saved.slice(0, MAX_SAVED), config.demo.repos, demoOpened);
  const term = query.trim();
  // the search looks through every saved repo, not only the few on the page
  const found = searching ? findRepos(orderPills(saved, config.demo.repos, demoOpened), term, MAX_FOUND) : [];

  return (
    <div
      ref={root}
      className={cx('gm-repo-pills', searching && 'is-searching')}
      style={held !== null ? { minHeight: held } : undefined}
      // the keyboard's "clicking elsewhere": the focus going to something outside
      onBlur={(e) => { if (searching && e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) closeSearch(); }}
    >
      {(shown.length > 0 || searching) && (
        <SearchField
          open={searching}
          query={query}
          pill={searchPill}
          input={searchInput}
          onOpen={openSearch}
          onQuery={setQuery}
          onEnter={() => { if (found[0]) open(found[0]); }}
        />
      )}
      {(searching ? found : shown).map((item) => {
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
      {searching && term !== '' && found.length === 0 && <p className="gm-repo-none" role="status">No repos match</p>}
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
    </div>
  );
}
