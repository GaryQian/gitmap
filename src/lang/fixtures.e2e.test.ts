// Every language fixture, end to end with the real plug-ins: fixture files → manifest → fast pass →
// slow pass → analyze (import resolution, header pairing, symbol linking) → unit edges. Each
// plug-in's own test checks its scanner, resolver and query alone; this checks what the map draws.
//
// fixtures/<id>/expected.json is the table. Besides the keys the plug-in tests read (`imports`,
// `notImports`, `calls`, `samePackage` / `sameNamespace` / `sameModule`, `headerPairs`) it may hold an
// `endToEnd` block, read only here:
//   linked     [src, dst, symbol]       joined by the linker with no import statement between the two
//                                       files: they share a package, namespace or module
//   ambiguous  [src, dst, symbol, why]  a call in `calls` whose name has several reachable
//                                       definitions; the linker drops it (PLAN.md §6.4)
//   notLinked  [src, dst, symbol, why]  the name belongs to something outside the repo: no edge from
//                                       src to dst may carry it
// Edges join units, and a header shares a unit with its implementation, so paths are mapped to units
// first and a pair that lands in one unit is skipped.
import { beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../analysis';
import { collectTasks } from '../compute';
import { config } from '../config';
import type { AnalysisResult } from '../contracts/pipeline';
import { buildManifest, runFastPass, runSlowPass } from '../ingest';
import { edgeId } from '../model';
import { fixtureExpected, fixtureFiles } from '../testing/fixture';
import { createFakePool, memoryRepo } from '../testing/memory';

type Pair = [string, string];
type Triple = [string, string, string, string?];
interface Expected {
  imports?: Pair[];
  notImports?: Pair[];
  calls?: Triple[];
  samePackage?: Pair[];
  sameNamespace?: Pair[];
  sameModule?: Pair[];
  headerPairs?: Pair[];
  endToEnd?: { linked?: Triple[]; ambiguous?: Triple[]; notLinked?: Triple[] };
}

const FIXTURES = ['three-lang', 'jvm', 'csharp', 'go', 'rust', 'dart', 'swift', 'objc', 'php', 'ruby', 'web'] as const;

/**
 * Expectations the code does not meet today. Each is left out of its fixture's ordinary checks and
 * asserted on its own with `it.fails`, so it turns red the day the defect is fixed.
 */
const DEFECTS: { fixture: string; list: 'calls' | 'notLinked'; entry: Triple; defect: string }[] = [
  // The Go plug-in reports lower-case names as `exported: false` (private to the file), but Go's
  // unexported names are visible to the whole package; the linker never indexes them.
  { fixture: 'go', list: 'calls', entry: ['internal/store/store.go', 'internal/store/ids.go', 'newID'], defect: 'Go: a call to an unexported function in another file of the package is dropped' },
  { fixture: 'go', list: 'calls', entry: ['internal/server/server.go', 'internal/server/routes.go', 'logRequests'], defect: 'Go: a call to an unexported function in another file of the package is dropped' },
  // The Rust query does not look inside macro token trees: `eprintln!("{}", version())` yields no reference.
  { fixture: 'rust', list: 'calls', entry: ['crates/cli/src/main.rs', 'crates/engine/src/lib.rs', 'version'], defect: 'Rust: a call inside a macro invocation is not extracted' },
  // The linker ignores that a name or qualifier is bound by an import that resolved outside the repo.
  { fixture: 'go', list: 'notLinked', entry: ['internal/store/item.go', 'internal/store/store.go', 'New'], defect: 'linker: `errors.New` is linked to the package\'s own New' },
  { fixture: 'go', list: 'notLinked', entry: ['internal/server/routes.go', 'internal/server/server.go', 'Handler'], defect: 'linker: `http.Handler` is linked to the package\'s own Handler method' },
  { fixture: 'jvm', list: 'notLinked', entry: ['app/src/main/kotlin/com/example/shop/service/Receipt.kt', 'analytics/src/main/scala/com/example/shop/analytics/Formatter.scala', 'Formatter'], defect: 'linker: a name imported from java.util is linked to the repo\'s only class of that name' },
];

const tasks = collectTasks(import.meta.glob('../ingest/**/*.task.ts', { eager: true }));
// One pool for the whole file, so each tree-sitter grammar is loaded once.
const pool = createFakePool({
  config, tasks,
  openRepo: async (locator) => {
    if (locator.kind !== 'memory') throw new Error(`unexpected locator: ${locator.kind}`);
    return memoryRepo(locator.name, locator.files);
  },
});

/** The edges of one analysis, looked up by file path. */
class Edges {
  private readonly unit = new Map<string, string>();
  private readonly at = new Map<string, number>();
  constructor(private readonly result: AnalysisResult) {
    const { file, edge } = result.tables;
    file.ids.forEach((id, i) => this.unit.set(id, file.cols.unit![i]));
    edge.ids.forEach((id, i) => this.at.set(id, i));
  }
  unitOf(path: string): string {
    const unit = this.unit.get(path);
    if (unit === undefined) throw new Error(`not on the map: ${path}`);
    return unit;
  }
  oneUnit(a: string, b: string): boolean { return this.unitOf(a) === this.unitOf(b); }
  has(a: string, b: string): boolean { return this.at.has(edgeId(this.unitOf(a), this.unitOf(b))); }
  /** Kind of the edge between the two files' units, or null when there is none. */
  kind(a: string, b: string): string | null {
    const e = this.at.get(edgeId(this.unitOf(a), this.unitOf(b)));
    return e === undefined ? null : this.result.tables.edge.cols.kind![e];
  }
  /** Symbols the edge names (without their counts); empty when there is no edge. */
  symbols(a: string, b: string): string[] {
    const e = this.at.get(edgeId(this.unitOf(a), this.unitOf(b)));
    const text = e === undefined ? '' : this.result.tables.edge.cols.symbols![e];
    return text ? text.split('|').map((s) => s.slice(0, s.lastIndexOf(':'))) : [];
  }
}

const sameEntry = (a: Triple, b: Triple) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

for (const name of FIXTURES) {
  describe(`fixtures/${name}, end to end`, () => {
    const expected = fixtureExpected<Expected>(name);
    const e2e = expected.endToEnd ?? {};
    const defects = DEFECTS.filter((d) => d.fixture === name);
    const known = (list: 'calls' | 'notLinked', entry: Triple) => defects.some((d) => d.list === list && sameEntry(d.entry, entry));
    const ambiguous = (entry: Triple) => (e2e.ambiguous ?? []).some((x) => sameEntry(x, entry));
    /** Symbol links the fixture promises and the code delivers. */
    const links = [...(expected.calls ?? []), ...(e2e.linked ?? [])].filter((c) => !ambiguous(c) && !known('calls', c));
    const scopeMates = [...(expected.samePackage ?? []), ...(expected.sameNamespace ?? []), ...(expected.sameModule ?? [])];

    /** Imports resolved, nothing linked: what the map shows before the slow pass is in. */
    let importsOnly: Edges;
    /** The full structure: imports, linked symbols and bridges. */
    let full: Edges;
    let result: AnalysisResult;
    /** True when `imports` promises an edge between the two files' units (the header's unit imports for it). */
    const importBacked = (a: string, b: string) => (expected.imports ?? []).some(([s, d]) => full.unitOf(s) === full.unitOf(a) && full.unitOf(d) === full.unitOf(b));

    beforeAll(async () => {
      const encoder = new TextEncoder();
      const files = Object.fromEntries(Object.entries(fixtureFiles(name)).map(([path, text]) => [path, encoder.encode(text)]));
      const repo = memoryRepo(name, files);
      await pool.setRepo({ kind: 'memory', name, files });
      const manifest = await buildManifest(repo, config);
      const facts = await runFastPass(manifest, pool, config);
      const syntax = await runSlowPass(manifest, pool, config);
      importsOnly = new Edges(analyze({ repoName: name, files: facts }, config));
      result = analyze({ repoName: name, files: facts, syntax, syntaxComplete: true }, config);
      full = new Edges(result);
    }, 60000);

    it('reports a full structure with linked references', () => {
      expect(result.structure).toBe('full');
      expect(result.diagnostics.importsResolved).toBeGreaterThan(0);
      expect(result.diagnostics.refsLinked).toBeGreaterThan(0);
    });

    it('draws an edge for every expected import, before and after symbol linking', () => {
      expect(expected.imports!.length).toBeGreaterThan(0);
      for (const [src, dst] of expected.imports!) {
        if (full.oneUnit(src, dst)) continue;
        expect(importsOnly.has(src, dst), `${src} → ${dst} (imports only)`).toBe(true);
        expect(full.has(src, dst), `${src} → ${dst}`).toBe(true);
      }
    });

    it('draws no import edge where the fixture says there is none', () => {
      for (const [src, dst] of expected.notImports ?? []) {
        // A file that is not on the map (a path that does not exist) cannot have an edge.
        if (!fixtureHas(importsOnly, src) || !fixtureHas(importsOnly, dst)) continue;
        if (full.oneUnit(src, dst) || importBacked(src, dst)) continue;
        expect(importsOnly.has(src, dst), `${src} → ${dst} (imports only)`).toBe(false);
        if ((e2e.notLinked ?? []).some((x) => x[0] === src && x[1] === dst && known('notLinked', x))) continue;
        // After linking, the pair may be joined only by a symbol the fixture names.
        const named = links.filter((c) => c[0] === src && c[1] === dst);
        if (named.length === 0) expect(full.kind(src, dst), `${src} → ${dst}`).toBeNull();
        else expect(full.kind(src, dst), `${src} → ${dst}`).not.toBe('import');
      }
    });

    if (links.length > 0) {
      it('turns every expected call and scope link into an edge that names the symbol', () => {
        for (const [src, dst, symbol] of links) {
          if (full.oneUnit(src, dst)) continue;
          expect(full.kind(src, dst), `${src} → ${dst}`).not.toBeNull();
          expect(full.kind(src, dst), `${src} → ${dst}`).not.toBe('import');
          expect(full.symbols(src, dst), `${src} → ${dst}`).toContain(symbol);
        }
      });
    }

    if (e2e.ambiguous?.length) {
      it('drops a call whose name has several reachable definitions', () => {
        for (const [src, dst, symbol] of e2e.ambiguous!) expect(full.symbols(src, dst), `${src} → ${dst}`).not.toContain(symbol);
      });
    }

    if (scopeMates.length > 0) {
      it('joins files of one package, namespace or module exactly when one references the other', () => {
        for (const [a, b] of scopeMates) {
          if (full.oneUnit(a, b)) continue;
          const between = (c: Triple) => (c[0] === a && c[1] === b) || (c[0] === b && c[1] === a);
          const promised = links.some(between);
          // A pair whose only promised link is a known defect is asserted by that defect's own test.
          if (!promised && defects.some((d) => between(d.entry))) continue;
          expect(full.has(a, b) || full.has(b, a), `${a} ↔ ${b}`).toBe(promised);
        }
      });
    }

    if (expected.headerPairs?.length) {
      it('puts a header and its implementation in one unit', () => {
        for (const [header, impl] of expected.headerPairs!) expect(full.unitOf(header), header).toBe(full.unitOf(impl));
      });
    }

    const outside = (e2e.notLinked ?? []).filter((x) => !known('notLinked', x));
    if (outside.length > 0) {
      it('does not link a name that belongs to something outside the repo', () => {
        for (const [src, dst, symbol] of outside) expect(full.symbols(src, dst), `${src} → ${dst}`).not.toContain(symbol);
      });
    }

    for (const d of defects) {
      const [src, dst, symbol] = d.entry;
      // Known defect, see DEFECTS: `it.fails` passes while the expectation below is not met.
      it.fails(`known defect — ${d.defect} (${symbol})`, () => {
        if (d.list === 'calls') expect(full.symbols(src, dst)).toContain(symbol);
        else expect(full.symbols(src, dst)).not.toContain(symbol);
      });
    }
  });
}

function fixtureHas(edges: Edges, path: string): boolean {
  try { edges.unitOf(path); return true; } catch { return false; }
}
