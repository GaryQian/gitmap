// Top left, under the title pill: one pill per selected file, each removable, with "+N more" beyond a
// handful and a clear-all action (PLAN.md §9, §17.6). Escape clears the selection.
import { useEffect, useState } from 'react';
import type { AppMount } from '../../contracts/app';
import type { NodeRef } from '../../model/types';
import { clearSelection, removeFromSelection, setFocus, useFocus, useRender, useReplica, useSelection } from '../store';
import { isTyping } from '../keys';
import { APP_LOCAL } from '../tunables';
import { CloseIcon, Pill, PillButton, Strong } from '../ui';
import { unitName } from '../units';
import './selected.css';

function SelectionPills() {
  const selection = useSelection();
  const focus = useFocus();
  const replica = useReplica();
  const render = useRender();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // a popup that closes on Escape takes the key in the capture phase, so it never reaches here
      if (e.key === 'Escape' && !e.defaultPrevented && !isTyping(e.target)) clearSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const many = selection.length > APP_LOCAL.selection.pillsShown;
  useEffect(() => { if (!many) setExpanded(false); }, [many]);

  if (selection.length === 0 || !replica) return null;
  // the newest selections are the ones kept in view, and the focused one always is
  let shown = selection;
  if (many && !expanded) {
    shown = selection.slice(-APP_LOCAL.selection.pillsShown);
    if (focus !== null && !shown.includes(focus)) shown = [focus, ...shown.slice(1)];
  }
  const hiddenCount = selection.length - shown.length;

  const show = (ref: NodeRef) => {
    setFocus(ref);
    void render?.flyTo(ref).catch(() => {});
  };

  return (
    <div className="gm-selected" role="group" aria-label={`Selection, ${selection.length} ${selection.length === 1 ? 'file' : 'files'}`}>
      <ul className={expanded ? 'gm-selected-list is-expanded' : 'gm-selected-list'}>
        {shown.map((ref) => {
          const name = unitName(replica, ref) ?? ref.slice(2);
          return (
            <li key={ref}>
              <Pill size="small" active={ref === focus} className="gm-selected-pill">
                <button type="button" className="gm-selected-name" title={ref.slice(2)} aria-pressed={ref === focus} onClick={() => show(ref)}>
                  {ref === focus ? <Strong>{name}</Strong> : name}
                </button>
                <button type="button" className="gm-icon-button" aria-label={`Remove ${name} from the selection`} title="Remove from the selection" onClick={() => removeFromSelection(ref)}>
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
