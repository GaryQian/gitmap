// Stage 6 — assemble the StructureTables the model should contain, every column filled.
import type { FileFacts } from '../contracts/lang';
import { edgeId, type StructureTables } from '../model/types';
import type { ClusterResult } from './cluster';
import type { UnitEdges } from './edges';
import type { UnitTable } from './units';

/** `files` is the path-ordered list the UnitTable was built from. */
export function assembleTables(
  files: readonly FileFacts[],
  units: UnitTable,
  edges: UnitEdges,
  importancePct: ArrayLike<number>,
  clusters: ClusterResult,
): StructureTables {
  const edgeIds = new Array<string>(edges.count);
  const src = new Array<string>(edges.count);
  const dst = new Array<string>(edges.count);
  for (let e = 0; e < edges.count; e++) {
    src[e] = units.ids[edges.src[e]];
    dst[e] = units.ids[edges.dst[e]];
    edgeIds[e] = edgeId(src[e], dst[e]);
  }
  return {
    city: {
      ids: clusters.cities.map((c) => c.id),
      cols: { name: clusters.cities.map((c) => c.name) },
    },
    district: {
      ids: clusters.districts.map((d) => d.id),
      cols: { city: clusters.districts.map((d) => d.city), name: clusters.districts.map((d) => d.name) },
    },
    unit: {
      ids: units.ids.slice(),
      cols: {
        primaryFile: units.primaryFile.slice(),
        fileCount: units.fileCount.slice(),
        loc: units.loc.slice(),
        bytes: units.bytes.slice(),
        lang: units.lang.slice(),
        importancePct: Array.from(importancePct),
        fanIn: Array.from(edges.fanIn),
        fanOut: Array.from(edges.fanOut),
        district: clusters.unitDistrict.slice(),
      },
    },
    file: {
      ids: files.map((f) => f.path),
      cols: {
        lang: files.map((f) => f.lang ?? 'other'),
        bytes: files.map((f) => f.bytes || 0),
        loc: files.map((f) => f.loc || 0),
        oid: files.map((f) => f.oid ?? ''),
        unit: Array.from(units.fileUnit, (u) => units.ids[u]),
      },
    },
    edge: {
      ids: edgeIds,
      cols: {
        src, dst,
        kind: edges.kind.slice(),
        weight: Array.from(edges.weight),
        confidence: Array.from(edges.confidence),
        mechanism: edges.mechanism.slice(),
        symbols: edges.symbols.slice(),
      },
    },
  };
}
