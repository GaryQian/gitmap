// Everything the section builders share for one build: the canonical view, lookups over the facts,
// the seeded display order and the withheld-file check.
import type { Config } from '../../config';
import type { FileFacts, SymbolDef, SyntaxFacts } from '../../contracts/lang';
import type { ModelReplica } from '../../contracts/store';
import { looksSecret, pathRules } from './filters';
import type { PathRules } from './filters';
import { buildView, EXCLUDED, SECRET, TEST } from './model';
import type { UnitInfo, View } from './model';
import { rngFor, shuffledRanks } from './seeded';
import { LOCAL } from './tunables';

export interface DigestInput {
  replica: ModelReplica;
  /** Fast-pass facts: the source of README / docs excerpts and build manifests. */
  files: readonly FileFacts[];
  /** Slow-pass facts: the source of signatures and doc comments. May be empty or partial. */
  syntax: readonly SyntaxFacts[];
  config: Config;
}

export class Ctx {
  readonly replica: ModelReplica;
  readonly config: Config;
  readonly rules: PathRules;
  readonly view: View;
  readonly seed: number;
  readonly facts = new Map<string, FileFacts>();
  readonly syntax = new Map<string, SyntaxFacts>();
  /** Shuffled display position of each city, district and unit (by canonical index). */
  readonly cityRank: Int32Array;
  readonly districtRank: Int32Array;
  readonly unitRank: Int32Array;
  private readonly withheld = new Map<string, boolean>();
  private readonly memo = new Map<string, unknown>();

  constructor(input: DigestInput) {
    this.replica = input.replica;
    this.config = input.config;
    this.rules = pathRules(input.config);
    this.view = buildView(input.replica, this.rules);
    this.seed = input.config.clustering.seed;
    for (const f of input.files) this.facts.set(f.path, f);
    for (const s of input.syntax) this.syntax.set(s.path, s);
    this.cityRank = shuffledRanks(this.view.cities.length, this.rng('cities'));
    this.districtRank = shuffledRanks(this.view.districts.length, this.rng('districts'));
    this.unitRank = shuffledRanks(this.view.units.length, this.rng('units'));
  }

  rng(salt: string): () => number {
    return rngFor(this.seed, salt);
  }

  /** Compute once per build. */
  once<T>(key: string, make: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key) as T;
  }

  /** A path that may be named and quoted: not vendored, generated, a fixture, a lockfile, a test or a secret. */
  pathShown(path: string): boolean {
    return !this.rules.excluded(path) && !this.rules.test(path) && !this.rules.secret(path);
  }

  /**
   * True when nothing of this file may leave the machine: a secret-named path, or key-shaped
   * content anywhere in what was kept of it (its excerpt, its signatures and doc comments).
   */
  fileWithheld(path: string): boolean {
    let hit = this.withheld.get(path);
    if (hit === undefined) {
      hit = this.rules.secret(path);
      if (!hit) {
        const excerpt = this.facts.get(path)?.excerpt;
        hit = excerpt !== undefined && looksSecret(excerpt);
      }
      if (!hit) {
        const defs = this.syntax.get(path)?.defs;
        if (defs?.length) {
          const kept: string[] = [];
          for (const d of defs) { if (d.signature) kept.push(d.signature); if (d.doc) kept.push(d.doc); }
          hit = looksSecret(kept.join('\n'));
        }
      }
      this.withheld.set(path, hit);
    }
    return hit;
  }

  unitWithheld(u: UnitInfo): boolean {
    if (u.flags & SECRET) return true;
    for (const path of u.files) if (this.fileWithheld(path)) return true;
    return false;
  }

  /**
   * A unit that may be named: placed on the map, and not a test, an excluded file or a withheld
   * one. A file with key-shaped content is dropped whole, so not even its path is shown.
   */
  citable(u: UnitInfo): boolean {
    return (u.flags & (EXCLUDED | TEST | SECRET)) === 0 && u.district >= 0 && !this.unitWithheld(u);
  }

  /** The unit's definitions in source order; a second file adds only names the first does not define. */
  defsOf(u: UnitInfo): SymbolDef[] {
    const out: SymbolDef[] = [];
    const seen = new Set<string>();
    u.files.forEach((path, i) => {
      const defs = this.syntax.get(path)?.defs;
      if (!defs) return;
      for (const d of [...defs].sort((a, b) => a.line - b.line)) {
        const key = `${d.container ?? ''}\u0000${d.name}`;
        if (i > 0 && seen.has(key)) continue;
        seen.add(key);
        out.push(d);
      }
    });
    return out;
  }

  hasDefs(u: UnitInfo): boolean {
    for (const path of u.files) if (this.syntax.get(path)?.defs.length) return true;
    return false;
  }

  /**
   * Stratified shares (PLAN.md §11.2): ∝ √size, with a floor so that small groups are not squeezed
   * out. Sums to 1.
   */
  static shares(sizes: readonly number[]): number[] {
    const n = sizes.length;
    if (n === 0) return [];
    const roots = sizes.map((s) => Math.sqrt(Math.max(0, s)));
    const sum = roots.reduce((a, b) => a + b, 0);
    const floor = LOCAL.skeletons.floor / n;
    const raw = roots.map((r) => Math.max(sum > 0 ? r / sum : 1 / n, floor));
    const total = raw.reduce((a, b) => a + b, 0);
    return raw.map((r) => r / total);
  }

  /** Each city's share of a repo-wide budget. */
  get cityShares(): number[] {
    return this.once('cityShares', () => Ctx.shares(this.view.cities.map((c) => c.files)));
  }
}
