// How feature folders plug into the React shell without editing it. Each feature folder under
// src/app/<feature>/ may export a default AppMount (or array) from `mount.tsx`; the shell discovers
// them with import.meta.glob('./*/mount.tsx') and renders them into named regions (PLAN.md §17.6).
import type { ComponentType } from 'react';

export type AppRegion =
  | 'topLeft' | 'topCenter' | 'topRight'
  | 'bottomLeft' | 'bottomCenter' | 'bottomRight'
  | 'rightEdge'   // the opaque sidebar reader
  | 'scene'       // full-bleed layer above the canvas for in-scene pills, tooltips, cards
  | 'overlay'     // modal layer (consent prompt, dialogs)
  | 'landing';    // below the "Choose a folder" button on the landing page

export interface AppMount {
  region: AppRegion;
  /** Lower comes first within a region. */
  order: number;
  /** Which screens show it. Default ['map']. */
  phases?: ('landing' | 'waiting' | 'map')[];
  Component: ComponentType;
}
