// Selection as pure transitions (PLAN.md §9): click replaces, Shift+click adds or removes, a marquee
// adds, Escape clears. `focus` is the one selected node whose detail card is open.
import type { NodeRef } from '../model/types';

export interface SelectionState {
  selection: NodeRef[];
  /** The selected node the detail card describes; always a member of `selection`, or null. */
  focus: NodeRef | null;
}

export const EMPTY_SELECTION: SelectionState = { selection: [], focus: null };

/** Click on a node: select it alone and focus it. Click on empty space: clear. */
export function clickSelect(_state: SelectionState, ref: NodeRef | null): SelectionState {
  return ref === null ? EMPTY_SELECTION : { selection: [ref], focus: ref };
}

/** Shift+click: add the node (and focus it), or remove it if it is already selected. On empty space: nothing. */
export function shiftClickSelect(state: SelectionState, ref: NodeRef | null): SelectionState {
  if (ref === null) return state;
  if (state.selection.includes(ref)) return removeSelected(state, ref);
  return { selection: [...state.selection, ref], focus: ref };
}

/** Marquee: add every node inside it, keeping order and whatever was focused. */
export function marqueeSelect(state: SelectionState, refs: readonly NodeRef[]): SelectionState {
  const selection = [...new Set([...state.selection, ...refs])];
  return selection.length === state.selection.length ? state : { selection, focus: state.focus };
}

/** Remove one node (the × on a selection pill). Focus moves to the most recent one left. */
export function removeSelected(state: SelectionState, ref: NodeRef): SelectionState {
  if (!state.selection.includes(ref)) return state;
  const selection = state.selection.filter((r) => r !== ref);
  const focus = state.focus === ref ? (selection[selection.length - 1] ?? null) : state.focus;
  return { selection, focus };
}

/** Focus a node that is already selected, or close the detail card with null. */
export function focusSelected(state: SelectionState, ref: NodeRef | null): SelectionState {
  if (ref !== null && !state.selection.includes(ref)) return state;
  return state.focus === ref ? state : { selection: state.selection, focus: ref };
}

/** Replace the whole selection (search results, the tour). A single node is focused; otherwise focus survives if it can. */
export function replaceSelection(state: SelectionState, refs: readonly NodeRef[]): SelectionState {
  const selection = [...new Set(refs)];
  const focus = selection.length === 1 ? selection[0]! : state.focus !== null && selection.includes(state.focus) ? state.focus : null;
  return { selection, focus };
}

export function clearSelection(_state?: SelectionState): SelectionState {
  return EMPTY_SELECTION;
}
