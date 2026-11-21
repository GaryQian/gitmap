// The `.gitmap.json.gz` format (PLAN.md §5, §12): one JSON document, gzipped.
//
// Inside the JSON, every string held in a table (ids and string columns) and every id in the layout
// is replaced by its index in one shared `strings` table: a path is written once however many
// columns mention it. Edge ids are not written at all when they equal edgeId(src, dst), which is
// what the pipeline produces, and a column that holds one value throughout (an empty `mechanism`, a
// `fileCount` of 1) is written as that value. Everything else (meta, layers, annotations, numbers)
// is plain JSON.
//
//   { "format": "gitmap", "schema": 1, "strings": [...], "meta": {...},
//     "tables": { "<kind>": { "n": rows, "ids": [string index] | null,
//                             "cols": { "<col>": { "s": [string index] } | { "k": the one value } | { "v": [value] } } } },
//     "layers": {...}, "annotations": {...},
//     "layout": { "unit": { "ids": [string index], "xz": [...] }, ... }   // only when the model has one
//   }
//
// decodeModel(encodeModel(m)) deep-equals m for anything JSON can carry. JSON cannot carry −0 (it reads
// back as 0), NaN or ±Infinity (they read back as null), or properties whose value is undefined.
//
// Uses CompressionStream / DecompressionStream, present in browsers, workers and Node 18+.
import { edgeId, EDGE_SEP, type ColumnChunk, type LayoutSnapshot, type RepoModel } from './types';

const FORMAT = 'gitmap';
const SCHEMA = 1;

type EncodedColumn = { s: number[] } | { k: string | number } | { v: unknown[] };
interface EncodedTable { n: number; ids: number[] | null; cols: Record<string, EncodedColumn> }
interface EncodedLayout {
  unit: { ids: number[]; xz: number[] };
  district: { ids: number[]; xzr: number[] };
  city: { ids: number[]; xzr: number[] };
  home: LayoutSnapshot['home'];
}
interface EncodedModel {
  format: typeof FORMAT;
  schema: number;
  strings: string[];
  meta: RepoModel['meta'];
  tables: Record<string, EncodedTable>;
  layers: RepoModel['layers'];
  annotations: RepoModel['annotations'];
  layout?: EncodedLayout;
}

class StringTable {
  readonly strings: string[] = [];
  private index = new Map<string, number>();
  indexOf(s: string): number {
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.strings.length;
      this.strings.push(s);
      this.index.set(s, i);
    }
    return i;
  }
  indexAll(values: string[]): number[] {
    const out = new Array<number>(values.length);
    for (let r = 0; r < values.length; r++) out[r] = this.indexOf(values[r]);
    return out;
  }
}

function isStringArray(values: unknown[]): values is string[] {
  for (let r = 0; r < values.length; r++) if (typeof values[r] !== 'string') return false;
  return values.length > 0;
}

/** `rows` is the table's row count: only a column of that length can be rebuilt from a single value. */
function encodeColumn(values: unknown[], rows: number, strings: StringTable): EncodedColumn {
  const first = values[0];
  if (rows > 1 && values.length === rows && (typeof first === 'string' || (typeof first === 'number' && Number.isFinite(first)))) {
    let r = 1;
    while (r < rows && values[r] === first) r++;
    if (r === rows) return { k: first };
  }
  return isStringArray(values) ? { s: strings.indexAll(values) } : { v: values };
}

/** True when every edge id is exactly edgeId(src, dst), so the ids need not be stored. */
function edgeIdsAreDerived(ids: string[], src: unknown, dst: unknown): boolean {
  if (!Array.isArray(src) || !Array.isArray(dst) || src.length !== ids.length || dst.length !== ids.length) return false;
  const sep = EDGE_SEP.charCodeAt(0);
  for (let r = 0; r < ids.length; r++) {
    const id = ids[r], a = src[r], b = dst[r];
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (id.length !== a.length + 1 + b.length || id.charCodeAt(a.length) !== sep || !id.startsWith(a) || !id.endsWith(b)) return false;
  }
  return true;
}

function toDocument(model: RepoModel): EncodedModel {
  const strings = new StringTable();
  const tables: Record<string, EncodedTable> = {};
  for (const [kind, chunk] of Object.entries(model.tables) as [string, ColumnChunk][]) {
    const source = chunk.cols as Record<string, unknown[]>;
    const derived = kind === 'edge' && edgeIdsAreDerived(chunk.ids, source.src, source.dst);
    const cols: Record<string, EncodedColumn> = {};
    // ids before columns, so a row's own id tends to get the lowest index
    const ids = derived ? null : strings.indexAll(chunk.ids);
    for (const c of Object.keys(source)) {
      const values = source[c];
      cols[c] = encodeColumn(values, chunk.ids.length, strings);
    }
    tables[kind] = { n: chunk.ids.length, ids, cols };
  }
  const doc: EncodedModel = {
    format: FORMAT,
    schema: model.schema,
    strings: strings.strings,
    meta: model.meta,
    tables,
    layers: model.layers,
    annotations: model.annotations,
  };
  const layout = model.layout;
  if (layout) {
    doc.layout = {
      unit: { ids: strings.indexAll(layout.unit.ids), xz: layout.unit.xz },
      district: { ids: strings.indexAll(layout.district.ids), xzr: layout.district.xzr },
      city: { ids: strings.indexAll(layout.city.ids), xzr: layout.city.xzr },
      home: layout.home,
    };
  }
  return doc;
}

function fromDocument(doc: EncodedModel): RepoModel {
  const strings = doc.strings;
  if (!Array.isArray(strings) || typeof doc.tables !== 'object' || doc.tables === null) throw new Error('Not a gitmap file: the string table or the tables are missing.');
  const lookUp = (indexes: number[]): string[] => {
    const out = new Array<string>(indexes.length);
    for (let r = 0; r < indexes.length; r++) out[r] = strings[indexes[r]];
    return out;
  };
  const tables: Record<string, ColumnChunk> = {};
  for (const [kind, table] of Object.entries(doc.tables)) {
    const cols: Record<string, unknown[]> = {};
    for (const [c, column] of Object.entries(table.cols)) {
      cols[c] = 's' in column ? lookUp(column.s) : 'k' in column ? new Array<unknown>(table.n).fill(column.k) : column.v;
    }
    let ids: string[];
    if (table.ids) ids = lookUp(table.ids);
    else {
      const src = cols.src as string[], dst = cols.dst as string[];
      if (!Array.isArray(src) || !Array.isArray(dst)) throw new Error(`Not a gitmap file: table '${kind}' has no ids.`);
      ids = new Array<string>(src.length);
      for (let r = 0; r < src.length; r++) ids[r] = edgeId(src[r], dst[r]);
    }
    tables[kind] = { ids, cols } as ColumnChunk;
  }
  const model: RepoModel = {
    schema: SCHEMA,
    meta: doc.meta,
    tables: tables as unknown as RepoModel['tables'],
    layers: doc.layers,
    annotations: doc.annotations,
  };
  const layout = doc.layout;
  if (layout) {
    model.layout = {
      unit: { ids: lookUp(layout.unit.ids), xz: layout.unit.xz },
      district: { ids: lookUp(layout.district.ids), xzr: layout.district.xzr },
      city: { ids: lookUp(layout.city.ids), xzr: layout.city.xzr },
      home: layout.home,
    };
  }
  return model;
}

async function pipeThrough(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Columnar JSON, gzipped: the `.gitmap.json.gz` format. */
export async function encodeModel(model: RepoModel): Promise<Uint8Array> {
  if (model.schema !== SCHEMA) throw new Error(`Cannot write a model with schema ${JSON.stringify(model.schema)}: this build writes schema ${SCHEMA}.`);
  const json = JSON.stringify(toDocument(model));
  return pipeThrough(new TextEncoder().encode(json), new CompressionStream('gzip'));
}

/** Inverse of encodeModel. Rejects when the bytes are not a gitmap file or the schema is not one this build reads. */
export async function decodeModel(bytes: Uint8Array): Promise<RepoModel> {
  let json: string;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      json = new TextDecoder().decode(await pipeThrough(bytes, new DecompressionStream('gzip')));
    } catch {
      throw new Error('Not a gitmap file: it is not gzip data, or it is cut short.');
    }
  } else if (bytes[0] === 0x7b /* { */) {
    // A host that serves .gz with Content-Encoding: gzip hands the browser the JSON already inflated.
    json = new TextDecoder().decode(bytes);
  } else {
    throw new Error('Not a gitmap file: it is not gzip data, or it is cut short.');
  }
  let doc: EncodedModel;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error('Not a gitmap file: its contents are not JSON.');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('Not a gitmap file: its contents are not a model.');
  if (doc.schema !== SCHEMA) {
    throw new Error(`Unsupported gitmap schema ${JSON.stringify(doc.schema)}: this build reads schema ${SCHEMA}. The file may come from a newer version.`);
  }
  if (doc.format !== FORMAT) throw new Error('Not a gitmap file: the format marker is missing.');
  return fromDocument(doc);
}
