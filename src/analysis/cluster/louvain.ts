// The one place that talks to graphology-communities-louvain.
//
// `louvain.detailed(graph).dendrogram`, as pinned by louvain.test.ts (the library does not document it):
//   - an array of typed arrays, one per level, each with one entry PER ORIGINAL NODE, indexed by
//     the node's insertion order in the graph (not by key);
//   - dendrogram[0] is the identity (every node alone);
//   - dendrogram[k][i] is node i's community after k aggregation passes, numbered 0..count-1; every
//     level is already expressed over the original nodes, so no composing of levels is needed;
//   - each level is a coarsening of the one before, and the last equals `communities`;
//   - it is null when the graph has no edges.
import { UndirectedGraph } from 'graphology';
import louvain from 'graphology-communities-louvain';
import { mulberry32 } from '../../shared';
import type { EdgeList } from './graph';

/**
 * Louvain partitions of nodes 0..nodes-1, finest first, coarsest (the final partition) last. Each
 * level maps node → community index. The all-singletons level is left out unless it is all there is.
 * Deterministic: nodes and edges go in in the order given, and the walk is seeded.
 */
export function louvainLevels(nodes: number, edges: EdgeList, resolution: number, seed: number): Int32Array[] {
  if (edges.count > 0) {
    const graph = new UndirectedGraph();
    for (let i = 0; i < nodes; i++) graph.addNode(i);
    for (let e = 0; e < edges.count; e++) graph.addUndirectedEdgeWithKey(e, edges.a[e], edges.b[e], { weight: edges.w[e] });
    const { dendrogram } = louvain.detailed(graph, { resolution, rng: mulberry32(seed), getEdgeWeight: 'weight' });
    if (dendrogram && dendrogram.length > 1) return dendrogram.slice(1).map((level) => Int32Array.from(level));
  }
  const alone = new Int32Array(nodes);
  for (let i = 0; i < nodes; i++) alone[i] = i;
  return [alone];
}
