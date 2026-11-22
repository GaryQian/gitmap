// Top centre, first in the row: the search pill (PLAN.md §9, §17.6). Compact at rest; it widens into
// a field on focus, on "/" or on Ctrl/Cmd+K, and lists matching files in a card beneath. Choosing a
// file selects it and flies the camera to it.
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { config } from '../../config';
import type { AppMount } from '../../contracts/app';
import type { SearchHit } from '../../contracts/pipeline';
import type { ModelReplica } from '../../contracts/store';
import { matchRanges } from '../../search';
import { languageColor } from '../../shared';
import { LAYER, isTyping, useDismissable } from '../keys';
import { setSelection, useApp, useRender, useSession } from '../store';
import { Card, CloseIcon, Pill, cx } from '../ui';
import { unitSummary } from '../units';
import { pieces } from './pieces';
import { SEARCH_UI } from './tunables';
import './search.css';

/** A magnifier in the style of the icons in ../ui (16 px, line, text colour). */
function SearchIcon() {
  return (
    <svg
      className="gm-search-icon" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </svg>
  );
}

/** The hits a query produced; kept together so the list is always highlighted for the query it answers. */
interface Results { query: string; hits: SearchHit[] }

function Marked({ path, ranges, from, to }: { path: string; ranges: readonly number[]; from: number; to: number }) {
  return (
    <>
      {pieces(path, ranges, from, to).map((piece, k) =>
        piece.hit ? <mark className="gm-search-hit" key={k}>{piece.text}</mark> : <span key={k}>{piece.text}</span>)}
    </>
  );
}

function Row({ hit, query, replica }: { hit: SearchHit; query: string; replica: ModelReplica | null }) {
  const { path } = hit;
  const nameAt = path.lastIndexOf('/') + 1;
  // The session's hits carry no ranges, so they are found again here, for the dozen paths on show.
  const ranges = matchRanges(path, query);
  const lang = (replica && unitSummary(replica, hit.ref)?.lang) || 'other';
  const color = languageColor(lang, config.visual, replica?.meta?.languages?.[lang]?.color);
  return (
    <>
      <span className="gm-search-dot" style={{ background: color }} aria-hidden="true" />
      <span className="gm-search-text">
        <span className="gm-search-name"><Marked path={path} ranges={ranges} from={nameAt} to={path.length} /></span>
        {nameAt > 0 && <span className="gm-search-dir"><Marked path={path} ranges={ranges} from={0} to={nameAt - 1} /></span>}
      </span>
    </>
  );
}

function SearchPill() {
  const session = useSession();
  const render = useRender();
  // Read when the list renders, not subscribed: a batch arriving must not redraw the list.
  const replica = useApp((s) => s.session?.replica ?? null);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Results | null>(null);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  /** Counts requests, so an answer that arrives after a newer question is dropped. */
  const asked = useRef(0);
  /** The last choice and the query it was made for: Enter repeats it while the query stands. */
  const chosen = useRef<{ query: string; hit: SearchHit } | null>(null);
  const listId = useId();
  const term = query.trim();

  useEffect(() => {
    const id = ++asked.current;
    if (!term || !session) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      session.search(term, SEARCH_UI.limit).then(
        (hits) => {
          if (asked.current !== id) return;
          setResults({ query: term, hits });
          setActive(0);
        },
        () => { if (asked.current === id) setResults({ query: term, hits: [] }); },
      );
    }, SEARCH_UI.debounceMs);
    return () => clearTimeout(timer);
  }, [term, session]);

  // "/" and Ctrl/Cmd+K reach for the field from anywhere on the map, except from another text field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey;
      // `key` is missing on the keydown some browsers send for autofill
      const commandK = e.key?.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      if ((!slash && !commandK) || e.defaultPrevented) return;
      const here = e.target === input.current;
      if (here ? slash : isTyping(e.target)) return; // a slash typed into the search is part of the query
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // capture: the map canvas takes pointer events for itself
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  // Escape clears and closes; the field gives the focus back to the map. One layer per press (keys.ts).
  useDismissable(focused, () => {
    clear();
    input.current?.blur();
  }, { layer: LAYER.list, owns: (field) => field === input.current });

  const listed = open && term !== '' && results !== null;
  const hits = listed ? results.hits : [];
  const activeId = hits.length > 0 ? `${listId}-${Math.min(active, hits.length - 1)}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const choose = (hit: SearchHit) => {
    chosen.current = { query: term, hit };
    setSelection([hit.ref]);
    void render?.flyTo(hit.ref).catch(() => {});
    setOpen(false);
  };

  const clear = () => {
    asked.current++;
    chosen.current = null;
    setQuery('');
    setResults(null);
    setOpen(false);
  };

  const onEnter = () => {
    if (!term || !session) return;
    if (listed && results.query === term) {
      const hit = hits[Math.min(active, hits.length - 1)];
      if (hit) choose(hit);
    } else if (!open && chosen.current?.query === term) {
      choose(chosen.current.hit); // the list is closed and the query unchanged: go there again
    } else {
      // Enter came before the answer to what was typed: ask now and take the best match.
      const id = ++asked.current;
      session.search(term, SEARCH_UI.limit).then((found) => {
        if (asked.current !== id) return;
        setResults({ query: term, hits: found });
        setActive(0);
        if (found[0]) choose(found[0]); else setOpen(true);
      }, () => {});
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!listed) { setOpen(true); break; }
        if (hits.length === 0) break;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((a) => (Math.min(a, hits.length - 1) + step + hits.length) % hits.length);
        break;
      }
      case 'Enter':
        e.preventDefault();
        onEnter();
        break;
    }
  };

  const expanded = focused || query !== '';
  return (
    <div className="gm-search" ref={wrap}>
      <Pill
        blur
        className={cx('gm-search-pill', expanded && 'is-expanded')}
        title={expanded ? undefined : 'Search files ( / )'}
        onMouseDown={(e) => {
          if (e.target === input.current || (e.target as Element).closest('button')) return;
          e.preventDefault(); // keep the press on the icon or the padding from taking focus away again
          input.current?.focus();
        }}
      >
        <SearchIcon />
        <input
          ref={input}
          className="gm-search-input"
          type="text"
          role="combobox"
          aria-label="Search files"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={listed}
          aria-controls={listed ? listId : undefined}
          aria-activedescendant={listed ? activeId : undefined}
          placeholder="Search files"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setFocused(true);
            if (term) setOpen(true);
          }}
          onBlur={() => {
            setFocused(false);
            setOpen(false);
          }}
          onKeyDown={onKeyDown}
        />
        {query !== '' && (
          <button
            type="button" className="gm-icon-button gm-search-clear" aria-label="Clear search" title="Clear"
            onClick={() => {
              clear();
              input.current?.focus();
            }}
          >
            <CloseIcon size={12} />
          </button>
        )}
      </Pill>
      {listed && (
        // mousedown is cancelled so a press in the list does not blur the field (which would close the list)
        <Card blur className="gm-search-card" onMouseDown={(e) => e.preventDefault()}>
          {hits.length === 0 ? (
            <p className="gm-search-empty" role="status">No files match</p>
          ) : (
            <ul className="gm-search-list" id={listId} role="listbox" aria-label="Matching files">
              {hits.map((hit, k) => {
                const isActive = `${listId}-${k}` === activeId;
                return (
                  <li
                    key={hit.path}
                    id={`${listId}-${k}`}
                    role="option"
                    aria-selected={isActive}
                    className={cx('gm-search-row', isActive && 'is-active')}
                    title={hit.path}
                    onPointerMove={() => { if (!isActive) setActive(k); }}
                    onClick={() => choose(hit)}
                  >
                    <Row hit={hit} query={results.query} replica={replica} />
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

// Before the progress pill (20) and the action pills (30): search comes first in the top centre.
const mount: AppMount = { region: 'topCenter', order: 10, Component: SearchPill };
export default mount;
