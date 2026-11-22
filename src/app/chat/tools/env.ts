// What a tool may touch: the replica to read, the session's search and file contents, the view as
// it stands, and the same actions the user's own controls call. The live one is built from the app's
// stores (live.ts); tests pass a recording fake.
import type { Config } from '../../../config';
import type { ContentSource } from '../../../contracts/git';
import type { SearchHit } from '../../../contracts/pipeline';
import type { ModelReplica } from '../../../contracts/store';
import type { NodeRef } from '../../../model/types';
import type { ReachDirection } from '../../../overlays';

export interface ViewSnapshot {
  selection: readonly NodeRef[];
  focus: NodeRef | null;
  activeOverlay: string | null;
  typeFilter: readonly string[];
  minBytes: number;
  openFile: NodeRef | null;
  /** Ownership: the viewer's choice; null = the contributor with the most commits. */
  contributorId: number | null;
  /** Dependency reach. */
  direction: ReachDirection;
  maxHops: number;
  /** The history overlays will never have data on this map. */
  noHistory: boolean;
  /** Which tab the side panel shows, or null while it is closed. */
  panel: 'file' | 'chat' | null;
}

export interface MapActions {
  setSelection(refs: NodeRef[]): void;
  addToSelection(refs: NodeRef[]): void;
  clearSelection(): void;
  setActiveOverlay(id: string | null): void;
  setContributor(id: number | null): void;
  setDirection(direction: ReachDirection): void;
  setTypeFilter(langs: string[]): void;
  setMinBytes(bytes: number): void;
  /** Open a file in the side panel, on the File tab. */
  openFile(ref: NodeRef): void;
  /** Fly the camera to a node. False when there is no renderer to fly. */
  flyTo(ref: NodeRef): boolean;
  /** The camera alone, back to the whole map. */
  showWholeMap(): boolean;
  /** Camera and layout, as the "Reset view" pill does. */
  resetView(): boolean;
}

export interface ToolEnv {
  replica: ModelReplica;
  config: Config;
  /** The map was opened from a folder on this machine (or an imported map has its folder beside it). */
  hasFolder: boolean;
  search(query: string, limit: number): Promise<SearchHit[]>;
  /** Null when file contents are unavailable (an imported map without its folder). */
  content: ContentSource | null;
  view(): ViewSnapshot;
  act: MapActions;
}
