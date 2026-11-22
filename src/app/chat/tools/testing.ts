// A small synthetic map and a recording ToolEnv, for the tests of this folder.
import { config } from '../../../config';
import type { ContentSource } from '../../../contracts/git';
import type { ModelReplica } from '../../../contracts/store';
import { createReplica } from '../../../model';
import type { ModelPatch, NodeRef } from '../../../model/types';
import { LAYER_DEFS, type OwnershipExtra } from '../../../overlays';
import { MemoryContentSource } from '../../../testing/memory';
import { syntheticBatch } from '../../../testing/synthetic';
import type { ToolEnv, ViewSnapshot } from './env';

export const PEOPLE = [
  { id: 1, name: 'Ada Lovelace', commits: 40 },
  { id: 2, name: 'José Álvarez', commits: 25 },
  { id: 3, name: 'Grace Hopper', commits: 12 },
  { id: 4, name: 'Adam Smith', commits: 3 },
];

/** 60 files in 2 cities of 2 districts, with history layers, a summary, a point of interest and a tour. */
export function testReplica(): ModelReplica {
  const replica = createReplica();
  replica.apply(syntheticBatch({ files: 60, cities: 2, districtsPerCity: 2, seed: 3, langs: ['ts', 'python'] }));
  const units = replica.table('unit');
  const slots = units.slots();
  const ids = slots.map((s) => units.ids[s]!);
  const extra: OwnershipExtra = {
    unitIds: ids,
    offsets: ids.map((_, i) => i * 2).concat(ids.length * 2),
    authorIds: ids.flatMap(() => [1, 2]),
    authorCommits: ids.flatMap(() => [3, 1]),
    contributors: PEOPLE,
  };
  const first = `u:${ids[0]}` as `u:${string}`;
  const ops: ModelPatch[] = [
    { op: 'layer', id: 'recency', def: LAYER_DEFS.recency, unitIds: ids, slots, values: ids.map((_, i) => 1_760_000_000 + i * 86_400), status: 'complete', coverage: 1 },
    { op: 'layer', id: 'ownership', def: LAYER_DEFS.ownership, unitIds: ids, slots, values: ids.map(() => 4), status: 'complete', coverage: 1, extra: extra as unknown as Record<string, unknown> },
    { op: 'layer', id: 'knowledgeRisk', def: LAYER_DEFS.knowledgeRisk, unitIds: ids, slots, values: ids.map(() => 0.75), status: 'complete', coverage: 1 },
    { op: 'layer', id: 'tests', def: LAYER_DEFS.tests, unitIds: ids, slots, values: ids.map(() => 2), status: 'complete', coverage: 1 },
    { op: 'annotation', value: { type: 'summary', id: 'summary:c0', parent: 'c:c0', label: 'Core', text: 'Holds the entry points.' } },
    { op: 'annotation', value: { type: 'poi', id: 'poi:1', parent: first, label: 'Main entry', summary: 'Where it starts.', kind: 'entry', evidence: 'Most depended on.', details: {} } },
    { op: 'annotation', value: { type: 'tour', id: 'tour', steps: [{ parent: first, frame: 'city', text: 'Start here.', highlights: [] }] } },
  ];
  replica.apply({ rev: replica.rev + 1, baseRev: replica.rev, ops });
  return replica;
}

export interface TestEnv extends ToolEnv {
  /** The view the actions have produced so far. */
  state: ViewSnapshot;
  /** Every action taken, in order: "flyTo c:c0". */
  log: string[];
}

export function testEnv(replica: ModelReplica = testReplica(), files: Record<string, string | Uint8Array> | null = {}): TestEnv {
  const state: ViewSnapshot = {
    selection: [], focus: null, activeOverlay: null, typeFilter: [], minBytes: 0, openFile: null,
    contributorId: null, direction: 'dependsOn', maxHops: Infinity, noHistory: false, panel: null,
  };
  const log: string[] = [];
  const content: ContentSource | null = files === null ? null : new MemoryContentSource(files);
  return {
    replica, config, hasFolder: true, content, state, log,
    async search(query, limit) {
      const q = query.toLowerCase();
      const units = replica.table('unit');
      return units.slots().map((s) => units.ids[s]!).filter((id) => id.toLowerCase().includes(q)).slice(0, limit)
        .map((path) => ({ ref: `u:${path}` as NodeRef, path, score: 1 }));
    },
    view: () => ({ ...state }),
    act: {
      setSelection(refs) { state.selection = refs; log.push(`select ${refs.length}`); },
      addToSelection(refs) { state.selection = [...new Set([...state.selection, ...refs])]; log.push(`add ${refs.length}`); },
      clearSelection() { state.selection = []; log.push('clear'); },
      setActiveOverlay(id) { state.activeOverlay = id; log.push(`overlay ${id}`); },
      setContributor(id) { state.contributorId = id; log.push(`contributor ${id}`); },
      setDirection(direction) { state.direction = direction; log.push(`direction ${direction}`); },
      setTypeFilter(langs) { state.typeFilter = langs; log.push(`types ${langs.join(',')}`); },
      setMinBytes(bytes) { state.minBytes = bytes; log.push(`minBytes ${bytes}`); },
      openFile(ref) { state.openFile = ref; state.panel = 'file'; log.push(`open ${ref}`); },
      flyTo(ref) { log.push(`flyTo ${ref}`); return true; },
      showWholeMap() { log.push('wholeMap'); return true; },
      resetView() { log.push('reset'); return true; },
    },
  };
}
