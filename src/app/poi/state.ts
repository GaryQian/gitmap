// The feature's own UI state: which point of interest is open, and who answers detail questions.
import { create } from 'zustand';
import type { DetailQuestion } from '../../contracts/ai';
import type { Poi } from '../../model/types';

/**
 * Asks the AI layer for one detail of one point of interest. It returns nothing: the answer arrives
 * through the model, as `annotation` batches that move `poi.details[question]` to `loading` and then
 * to `ready` (with `markdown`) or `error`.
 */
export type DetailRequester = (poi: Poi, question: DetailQuestion) => void;

interface PoiUiState {
  /** Id of the point of interest whose card is open. */
  openId: string | null;
  requester: DetailRequester | null;
}

export const usePoiUi = create<PoiUiState>()(() => ({ openId: null, requester: null }));

/** Register the function the detail buttons call, or null to remove it. Without one, unanswered questions are not offered. */
export function setDetailRequester(requester: DetailRequester | null): void {
  usePoiUi.setState({ requester });
}

/** Open the detail card of a point of interest by id (the tour may call this). */
export function openPoi(id: string): void {
  if (usePoiUi.getState().openId !== id) usePoiUi.setState({ openId: id });
}

export function closePoi(): void {
  if (usePoiUi.getState().openId !== null) usePoiUi.setState({ openId: null });
}

// This module holds state (the registered requester). Hot-swapping it would leave two copies alive.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
