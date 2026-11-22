// The map overview: built from a replica alone, the same text in any session, within its budget.
import { describe, expect, it } from 'vitest';
import { createReplica } from '../../model';
import type { ColumnChunk, StructureTables, Summary } from '../../model/types';
import { syntheticTables, tablesToFullBatch } from '../../testing/synthetic';
import { estimateTokens } from '../tokens';
import { buildChatContext } from './context';
import { CHAT_TUNABLES } from './tunables';

/** The same model with every table's rows reversed, so every slot differs. */
function reversed(tables: StructureTables): StructureTables {
  const flip = <K extends keyof StructureTables>(chunk: ColumnChunk<K>): ColumnChunk<K> => ({
    ids: [...chunk.ids].reverse(),
    cols: Object.fromEntries(Object.entries(chunk.cols).map(([k, v]) => [k, [...(v as unknown[])].reverse()])) as ColumnChunk<K>['cols'],
  });
  return { city: flip(tables.city), district: flip(tables.district), unit: flip(tables.unit), file: flip(tables.file), edge: flip(tables.edge) };
}

function replicaOf(tables: StructureTables, summaries: Summary[] = []) {
  const replica = createReplica();
  const batch = tablesToFullBatch(tables);
  batch.ops.push(...summaries.map((value) => ({ op: 'annotation' as const, value })));
  replica.apply(batch);
  return replica;
}

describe('buildChatContext', () => {
  const tables = syntheticTables({ files: 400, cities: 5, districtsPerCity: 4, seed: 7 });
  const cityId = tables.city.ids[0];
  const summary: Summary = { type: 'summary', id: `summary:${cityId}`, parent: `c:${cityId}`, label: 'Request handling', text: 'Receives requests\nand routes them.' };

  it('names the repository, its languages and every city with its ref, districts and summary', () => {
    const text = buildChatContext(replicaOf(tables, [summary]));
    expect(text).toContain('Repository: synthetic');
    expect(text).toMatch(/Size: 400 files, \d+ lines, 5 cities, 20 districts\./);
    expect(text).toContain('Languages by share of lines:');
    for (const id of tables.city.ids) expect(text).toContain(`c:${id} | `);
    for (const id of tables.district.ids) expect(text).toContain(`d:${id} `);
    // a city with a summary goes by the summary's title, as on the map, with its folder name after it
    expect(text).toContain(`c:${cityId} | Request handling (${tables.city.cols.name![0]}) | `);
    expect(text).toContain('summary: Receives requests and routes them.');
    expect(estimateTokens(text)).toBeLessThanOrEqual(CHAT_TUNABLES.contextTokens);
  });

  it('is the same text whatever the slots are, so it stays a cached prefix', () => {
    const a = buildChatContext(replicaOf(tables, [summary]));
    expect(buildChatContext(replicaOf(tables, [summary]))).toBe(a);
    expect(buildChatContext(replicaOf(reversed(tables), [summary]))).toBe(a);
  });

  it('gives up district names, then summary length, to stay within a small budget', () => {
    const long: Summary[] = tables.city.ids.map((id) => ({ type: 'summary', id: `summary:${id}`, parent: `c:${id}`, text: 'word '.repeat(200) }));
    const replica = replicaOf(tables, long);
    const full = buildChatContext(replica, { maxTokens: 100_000 });
    const tight = buildChatContext(replica, { maxTokens: 400 });
    expect(estimateTokens(tight)).toBeLessThanOrEqual(400);
    expect(tight.length).toBeLessThan(full.length);
    for (const id of tables.city.ids) expect(tight).toContain(`c:${id} | `); // every city is still there
    expect(estimateTokens(buildChatContext(replica, { maxTokens: 40 }))).toBeLessThanOrEqual(40);
  });

  it('describes an empty map without failing', () => {
    expect(buildChatContext(createReplica())).toContain('no cities yet');
  });
});
