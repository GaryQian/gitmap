// Ownership: whose share of the commits the map shows (PLAN.md §10). A field that lists the
// contributors, most commits first, when it has focus; typing narrows the list, with a typo forgiven.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { HistoryContributor } from '../../overlays';
import { LAYER, useDismissable } from '../keys';
import { cx } from '../ui';
import { filterContributors } from './logic';
import { OVERLAY_UI } from './tunables';

const commitCount = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'commit' : 'commits'}`;

export interface ContributorPickerProps {
  contributors: readonly HistoryContributor[];
  /** The contributor on show; null while there is none to show. */
  chosen: HistoryContributor | null;
  onChoose: (id: number) => void;
}

export function ContributorPicker({ contributors, chosen, onChoose }: ContributorPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const matches = useMemo(() => (open ? filterContributors(contributors, query) : []), [open, contributors, query]);
  const rows = matches.length > OVERLAY_UI.contributorsShown ? matches.slice(0, OVERLAY_UI.contributorsShown) : matches;
  const at = rows.length > 0 ? Math.min(active, rows.length - 1) : -1;
  const activeId = at >= 0 ? `${listId}-${at}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const choose = (c: HistoryContributor) => {
    onChoose(c.id);
    close();
    input.current?.blur();
  };

  // Escape closes the list and keeps the choice; the card it is in stays (one layer per press, keys.ts)
  useDismissable(open, () => {
    close();
    input.current?.blur();
  }, { layer: LAYER.list, owns: (field) => field === input.current });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (rows.length === 0) break;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((at + step + rows.length) % rows.length);
        break;
      }
      case 'Home':
      case 'End':
        if (rows.length === 0 || query !== '') break; // with text in the field these move the caret
        e.preventDefault();
        setActive(e.key === 'Home' ? 0 : rows.length - 1);
        break;
      case 'Enter':
        e.preventDefault();
        if (at >= 0) choose(rows[at]!);
        break;
    }
  };

  const none = contributors.length === 0;
  return (
    <div className="gm-ov-picker">
      <div
        className={cx('gm-ov-field', open && 'is-open', none && 'is-empty')}
        onMouseDown={(e) => {
          if (e.target === input.current || none) return;
          e.preventDefault(); // a press on the count or the padding goes to the field
          input.current?.focus();
        }}
      >
        <input
          ref={input}
          className="gm-ov-input"
          type="text"
          role="combobox"
          aria-label="Contributor"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? activeId : undefined}
          placeholder={none ? 'No contributors yet' : open ? 'Find a contributor' : ''}
          disabled={none}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={open ? query : chosen?.name ?? ''}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onFocus={() => {
            setOpen(true);
            setQuery('');
            // start on the current choice, so the arrows move from where the viewer is
            setActive(Math.max(0, chosen ? filterContributors(contributors, '').findIndex((c) => c.id === chosen.id) : 0));
          }}
          onBlur={close}
          onKeyDown={onKeyDown}
        />
        {!open && chosen && <span className="gm-ov-count">{commitCount(chosen.commits)}</span>}
      </div>
      {open && (
        // mousedown is cancelled so a press in the list does not blur the field (which would close the list)
        <div className="gm-ov-options" onMouseDown={(e) => e.preventDefault()}>
          {rows.length === 0 ? (
            <p className="gm-ov-line" role="status">No contributors match</p>
          ) : (
            <ul className="gm-ov-list" id={listId} role="listbox" aria-label="Contributors, most commits first">
              {rows.map((c, k) => {
                const isActive = k === at;
                const isChosen = c.id === chosen?.id;
                return (
                  <li
                    key={c.id}
                    id={`${listId}-${k}`}
                    role="option"
                    aria-selected={isActive}
                    aria-label={`${c.name}, ${commitCount(c.commits)}${isChosen ? ', shown now' : ''}`}
                    className={cx('gm-ov-option', isActive && 'is-active', isChosen && 'is-chosen')}
                    title={c.name}
                    onPointerMove={() => { if (!isActive) setActive(k); }}
                    onClick={() => choose(c)}
                  >
                    <span className="gm-ov-name">{c.name}</span>
                    <span className="gm-ov-count">{c.commits.toLocaleString()}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {matches.length > rows.length && (
            <p className="gm-ov-line">{(matches.length - rows.length).toLocaleString()} more. Type to narrow the list.</p>
          )}
        </div>
      )}
    </div>
  );
}
