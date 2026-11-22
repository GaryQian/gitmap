// Top left, under the title pill: one pill per selected file, city or district, each removable, with
// "+N more" beyond a handful and a clear-all action (PLAN.md §9, §17.6). Escape clears the selection.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AppMount } from '../../contracts/app';
import type { NodeRef } from '../../model/types';
import { clearSelection, removeFromSelection, setFocus, useFocus, useRender, useReplica, useSelection } from '../store';
import { LAYER, useDismissable } from '../keys';
import { isAreaRef } from '../selectionState';
import { APP_LOCAL } from '../tunables';
import { CloseIcon, Pill, PillButton, Strong } from '../ui';
import { areaName } from '../areas';
import { unitName } from '../units';
import './selected.css';

function SelectionPills() {
  const selection = useSelection();
  const focus = useFocus();
  const replica = useReplica();
  const render = useRender();
  const [expanded, setExpanded] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  /** Where in the list the keyboard focus goes once a removed pill is gone. */
  const refocus = useRef<number | null>(null);

  // Escape clears the selection, after everything that lies over it has closed (keys.ts)
  useDismissable(selection.length > 0, clearSelection, { layer: LAYER.selection });

  const many = selection.length > APP_LOCAL.selection.pillsShown;
  useEffect(() => { if (!many) setExpanded(false); }, [many]);

  // the pill that held the focus was removed: the one that took its place gets it
  useEffect(() => {
    const at = refocus.current;
    refocus.current = null;
    if (at === null) return;
    const names = list.current?.querySelectorAll<HTMLButtonElement>('.gm-selected-name');
    names?.[Math.min(at, names.length - 1)]?.focus();
  }, [selection]);

  if (selection.length === 0 || !replica) return null;
  // the newest selections are the ones kept in view, and the focused one always is
  let shown = selection;
  if (many && !expanded) {
    shown = selection.slice(-APP_LOCAL.selection.pillsShown);
    if (focus !== null && !shown.includes(focus)) shown = [focus, ...shown.slice(1)];
  }
  const hiddenCount = selection.length - shown.length;
  const areas = selection.some(isAreaRef);

  const show = (ref: NodeRef) => {
    setFocus(ref);
    void render?.flyTo(ref).catch(() => {});
  };
  const remove = (ref: NodeRef, at: number, e: { currentTarget: Element }) => {
    // only when the focus is in this pill: a click with the pointer leaves the focus where it was
    if (e.currentTarget.closest('li')?.contains(document.activeElement)) refocus.current = at;
    removeFromSelection(ref);
  };
  const onNameKey = (ref: NodeRef, at: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    e.preventDefault();
    remove(ref, at, e);
  };

  return (
    <div className="gm-selected" role="group" aria-label={`Selection, ${selection.length} ${areas ? (selection.length === 1 ? 'item' : 'items') : selection.length === 1 ? 'file' : 'files'}`}>
      <ul className={expanded ? 'gm-selected-list is-expanded' : 'gm-selected-list'} ref={list}>
        {shown.map((ref, at) => {
          const area = areaName(replica, ref);
          const name = area?.name ?? unitName(replica, ref) ?? ref.slice(2);
          const what = area ? (area.kind === 'city' ? `${area.name}, a city` : area.city ? `${area.name}, a district of ${area.city}` : `${area.name}, a district`) : ref.slice(2);
          return (
            <li key={ref}>
              <Pill size="small" active={ref === focus} className="gm-selected-pill">
                <button
                  type="button"
                  className="gm-selected-name"
                  data-ref={ref}
                  title={`${what} (Delete removes it from the selection)`}
                  aria-pressed={ref === focus}
                  onClick={() => show(ref)}
                  onKeyDown={onNameKey(ref, at)}
                >
                  {ref === focus ? <Strong>{name}</Strong> : name}
                </button>
                <button type="button" className="gm-icon-button" aria-label={`Remove ${name} from the selection`} title="Remove from the selection" onClick={(e) => remove(ref, at, e)}>
                  <CloseIcon size={12} />
                </button>
              </Pill>
            </li>
          );
        })}
      </ul>
      {(many || selection.length > 1) && (
        <div className="gm-selected-actions">
          {many && (
            <PillButton size="small" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show fewer' : `+${hiddenCount.toLocaleString()} more`}
            </PillButton>
          )}
          <PillButton size="small" onClick={clearSelection}>Clear all</PillButton>
        </div>
      )}
    </div>
  );
}

const mount: AppMount = { region: 'topLeft', order: 10, Component: SelectionPills };
export default mount;
