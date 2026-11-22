// Public surface of src/overlays (package 4C): everything the overlay UI calls on the main thread.
// It must stay free of parsers and plug-ins: no imports from src/analysis, src/lang, src/ingest or
// src/pipeline. The pipeline-side layer builders live in src/analysis/layers and import from here.
//
//   types.ts      HistoryInput / FileHistory (what an adapter over the history walk fills), layer conventions
//   adjacency.ts  buildAdjacency, computeReach      Dependency reach, on demand
//   ownership.ts  ownershipShare                    one contributor's share, on demand
//   colors.ts     OVERLAY_COLORS, OVERLAY_RAMP      the tunable colours
//   view.ts       overlayView, legendFor, OVERLAYS  what RenderApi.setOverlay and the overlay UI take
export type { FileHistory, HistoryContributor, HistoryInput, OverlayId, OwnershipExtra } from './types';
export { LAYER_DEFS, RECENCY_OLDER, TESTS } from './types';
export { buildAdjacency, computeReach, type Adjacency, type ReachDirection } from './adjacency';
export { ownershipContributors, ownershipExtra, ownershipShare } from './ownership';
export { OVERLAY_COLORS, OVERLAY_RAMP, fadedColor, mixHex, unknownColor, type OverlayPalette } from './colors';
export {
  OVERLAYS, formatAge, legendFor, overlayView,
  type OverlayContext, type OverlayInfo, type OverlayLegend, type OverlayViewInfo,
} from './view';
