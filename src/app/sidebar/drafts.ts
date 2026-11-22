// The editor's working state, apart from the app store because nothing outside this folder reads it:
// unsaved text per file (so switching tabs or closing the panel loses nothing), the text each file
// last had on disk, and the file to bring back when the closed panel is reopened. All of it belongs
// to one session; a new map starts empty.
import { create } from 'zustand';
import type { Session } from '../../contracts/pipeline';
import type { NodeRef } from '../../model/types';

export interface EditState {
  session: Session | null;
  /** Text in the editor, by path; only files that were typed in. */
  drafts: Record<string, string>;
  /** Text on disk as last read or saved, by path. */
  base: Record<string, string>;
  /** The last file the panel showed, for the reopen button. */
  lastFile: NodeRef | null;
  /** The panel is open with no file in it (reopened before any file was opened). */
  emptyOpen: boolean;
}

export const useEdits = create<EditState>()(() => ({ session: null, drafts: {}, base: {}, lastFile: null, emptyOpen: false }));

/** Forget everything when the map changes. */
export function bindSession(session: Session | null): void {
  if (useEdits.getState().session === session) return;
  useEdits.setState({ session, drafts: {}, base: {}, lastFile: null, emptyOpen: false });
}

export function setDraft(path: string, text: string): void {
  useEdits.setState((s) => ({ drafts: { ...s.drafts, [path]: text } }));
}

/** Record what is on disk. A draft equal to it is no longer kept. */
export function setBase(path: string, text: string): void {
  useEdits.setState((s) => {
    const drafts = { ...s.drafts };
    if (drafts[path] === text) delete drafts[path];
    return { base: { ...s.base, [path]: text }, drafts };
  });
}

export function discardDraft(path: string): void {
  useEdits.setState((s) => {
    const drafts = { ...s.drafts };
    delete drafts[path];
    return { drafts };
  });
}

export function isDirty(s: EditState, path: string): boolean {
  const draft = s.drafts[path];
  return draft !== undefined && draft !== s.base[path];
}

export function anyDirty(s: EditState): boolean {
  return Object.keys(s.drafts).some((p) => isDirty(s, p));
}

export function rememberFile(ref: NodeRef): void {
  if (useEdits.getState().lastFile !== ref || useEdits.getState().emptyOpen) useEdits.setState({ lastFile: ref, emptyOpen: false });
}

export function setEmptyOpen(emptyOpen: boolean): void { useEdits.setState({ emptyOpen }); }

// Leaving the page with unsaved edits asks first.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (anyDirty(useEdits.getState())) e.preventDefault();
  });
}
