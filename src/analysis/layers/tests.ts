// The Tests layer (PLAN.md §10): test files, source files a test references, and source files no
// test references. Built from structure alone (paths and unit edges), so it is ready at the reveal.
import picomatch from 'picomatch';
import { config as defaultConfig, type Config } from '../../config';
import { LAYER_DEFS, TESTS } from '../../overlays';
import { IMAGE_LANG } from '../../shared';
import type { LayerPatch } from './history';
import { unitIndex, type StructureSource } from './structure';

/** True for a repo-relative path that matches one of the test patterns (config.overlays.tests.patterns). */
export function testMatcher(patterns: readonly string[]): (path: string) => boolean {
  return picomatch([...patterns], { dot: true, windows: false });
}

/**
 * One category per unit: TESTS.test for a unit with a file matching the patterns, TESTS.covered
 * for a source unit some test unit has an edge to (imports, calls, references), TESTS.uncovered
 * for the rest. Units that are not code (language 'other', and images) stay NaN.
 */
export function testsValues(source: StructureSource, patterns: readonly string[]): { unitIds: string[]; values: number[] } {
  const units = unitIndex(source);
  const n = units.unitIds.length;
  const isTestPath = testMatcher(patterns);
  const isTest = new Uint8Array(n);
  for (let f = 0; f < units.filePaths.length; f++) {
    const u = units.fileUnit[f];
    if (u >= 0 && isTestPath(units.filePaths[f])) isTest[u] = 1;
  }
  const referenced = new Uint8Array(n);
  for (let e = 0; e < units.edgeSrc.length; e++) {
    const s = units.edgeSrc[e], d = units.edgeDst[e];
    if (s >= 0 && d >= 0 && isTest[s]) referenced[d] = 1;
  }
  const values = new Array<number>(n);
  for (let u = 0; u < n; u++) {
    const lang = units.unitLang[u];
    values[u] = lang === 'other' || lang === IMAGE_LANG ? NaN : isTest[u] ? TESTS.test : referenced[u] ? TESTS.covered : TESTS.uncovered;
  }
  return { unitIds: units.unitIds.slice(), values };
}

/** The Tests layer as one `layer` operation covering every unit. */
export function testsLayer(source: StructureSource, cfg: Config = defaultConfig): LayerPatch {
  return { op: 'layer', id: 'tests', def: LAYER_DEFS.tests, ...testsValues(source, cfg.overlays.tests.patterns), status: 'complete', coverage: 1 };
}
