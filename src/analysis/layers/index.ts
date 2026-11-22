// Pipeline-side layer builders (package 4C): facts → `layer` operations ready for store.propose.
// Everything the overlay UI calls on the main thread lives in src/overlays instead; this folder
// may pull in picomatch and sits behind src/analysis, which the main bundle never imports.
//
//   history.ts    HistoryInput → Recency, Knowledge risk, Ownership (call again as walk chunks land)
//   tests.ts      structure → Tests (once, at the reveal, and again when structure changes)
//   structure.ts  the unit rows both read, from a replica or from StructureTables
export type { FileHistory, HistoryContributor, HistoryInput, OwnershipExtra } from '../../overlays';
export {
  aggregateHistory, historyLayers, knowledgeRiskLayer, knowledgeRiskValues, ownershipExtraOf, ownershipLayer, ownershipValues,
  recencyLayer, recencyValues,
  type HistoryLayerState, type LayerPatch, type UnitHistory,
} from './history';
export { testMatcher, testsLayer, testsValues } from './tests';
export { unitIndex, type StructureSource, type UnitIndex } from './structure';
