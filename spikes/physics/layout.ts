// Three-tier d3-force layout (PLAN 7.1/7.2). DOM-free: used by Node bench and the worker.
import {
  forceSimulation, forceLink, forceCollide, forceManyBody, forceRadial, forceX, forceY,
  type Simulation, type SimulationNodeDatum, type SimulationLinkDatum, type ForceLink,
  type ForceCollide, type ForceRadial,
} from "d3-force";
import { type Graph, mulberry32, fileRadiusFromU } from "./graph.ts";

export interface PN extends SimulationNodeDatum {
  i: number; // global id within its tier
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}
export type PL = SimulationLinkDatum<PN> & { w: number; source: PN; target: PN };
export type Sim = Simulation<PN, PL>;

export const CFG = {
  velocityDecay: 0.6,
  settleTicks: 150,
  alphaMin: 0.001,
  reheat: 0.3,
  city: { gap: 40, linkStrength: 0.5, charge: -60, gravity: 0.02 },
  district: { pad: 6, linkStrength: 0.6, externalPull: 0.15 },
  file: { pad: 0.5, sizeVsConnectivity: 0.5, baseStrength: 0.1, gap: 2 },
  packing: 0.5,
};
// alpha_n = (1-decay)^n  ->  decay = 1 - alphaMin^(1/ticks)
export const ALPHA_DECAY = 1 - Math.pow(CFG.alphaMin, 1 / CFG.settleTicks);

// ---- custom forces (d3 contract: force(alpha) + initialize(nodes, random)) ----

/** Keep each node's disc inside a circle of radius R() centred at the local origin. */
export function forceContain(R: () => number, strength = 0.5) {
  let nodes: PN[] = [];
  function force(_alpha: number) {
    const lim0 = R();
    for (const n of nodes) {
      const x = n.x + n.vx, y = n.y + n.vy; // predicted position
      const d = Math.hypot(x, y);
      const lim = Math.max(0, lim0 - n.r);
      if (d > lim && d > 0) {
        const k = ((d - lim) / d) * strength;
        n.vx -= x * k;
        n.vy -= y * k;
      }
    }
  }
  force.initialize = (ns: PN[], _random: () => number) => { nodes = ns; };
  return force;
}

/** Constant pull (alpha-scaled) toward a precomputed bearing per node. */
export function forceExternalPull(dir: (n: PN) => [number, number], strength: number, scale: number) {
  let nodes: PN[] = [];
  let dirs: [number, number][] = [];
  function force(alpha: number) {
    for (let k = 0; k < nodes.length; k++) {
      const n = nodes[k], d = dirs[k];
      n.vx += d[0] * strength * alpha * scale;
      n.vy += d[1] * strength * alpha * scale;
    }
  }
  force.initialize = (ns: PN[]) => { nodes = ns; dirs = ns.map(dir); };
  return force;
}

// ---- layout ----

interface FileSimParts {
  sim: Sim;
  nodes: PN[];
  links: PL[];
  link: ForceLink<PN, PL>;
  radial: ForceRadial<PN>;
  collide: ForceCollide<PN>;
  targets: Map<PN, number>;
}

export interface LayoutOpts {
  /** 'jitter' = random in 0.7R disc (baseline); 'spiral' = golden-angle at the node's radial (size-rank) target */
  init?: "jitter" | "spiral";
  /** 'd3' = forceCollide (quadtree); 'grid' = forceGridCollide (spatial hash, same contract) */
  collide?: "d3" | "grid";
  /** ticks to rest for file sims (alphaDecay derived from it); default CFG.settleTicks */
  fileTicks?: number;
}

export interface TierTiming { ms: number; ticks: number; sims: number; maxSimMs: number }

export class Layout {
  g: Graph;
  rnd: () => number;
  cityNodes: PN[] = [];
  citySim!: Sim;
  cityCollide!: ForceCollide<PN>;
  districtNodes: PN[] = [];
  districtSims: Sim[] = [];
  districtCollides: ForceCollide<PN>[] = [];
  fileNodes: PN[] = [];
  files: FileSimParts[] = [];
  districtR: Float64Array;
  cityR: Float64Array;
  tickEvents = 0; // counts d3-timer-driven 'tick' events (should stay 0)

  opts: LayoutOpts;
  constructor(g: Graph, seed = 7, opts: LayoutOpts = {}) {
    this.g = g;
    this.opts = opts;
    this.rnd = mulberry32(seed);
    this.districtR = new Float64Array(g.nDistricts);
    this.cityR = new Float64Array(g.nCities);
    this.computeRadii();
    this.buildCity();
    this.buildDistricts();
    this.buildFiles();
  }

  allSims(): Sim[] {
    return [this.citySim, ...this.districtSims, ...this.files.map((f) => f.sim)];
  }

  computeRadii() {
    const { g } = this;
    for (let d = 0; d < g.nDistricts; d++) this.districtR[d] = this.radiusForDistrict(d);
    for (let c = 0; c < g.nCities; c++) this.cityR[c] = this.radiusForCity(c);
  }
  radiusForDistrict(d: number): number {
    let a = 0;
    if (this.files[d]) for (const n of this.files[d].nodes) a += (n.r + CFG.file.pad) ** 2;
    else for (const f of this.g.districtFiles[d]) a += (this.g.fileR[f] + CFG.file.pad) ** 2;
    return Math.sqrt(a / CFG.packing) + 2;
  }
  radiusForCity(c: number): number {
    let a = 0;
    for (const d of this.g.cityDistricts[c]) a += (this.districtR[d] + CFG.district.pad) ** 2;
    return Math.sqrt(a / CFG.packing);
  }

  private mkSim(nodes: PN[]): Sim {
    const s = forceSimulation<PN, PL>(nodes)
      .velocityDecay(CFG.velocityDecay)
      .alphaDecay(ALPHA_DECAY)
      .alphaMin(CFG.alphaMin);
    s.stop(); // we own the clock
    s.on("tick", () => { this.tickEvents++; });
    return s;
  }

  private buildCity() {
    const { g } = this;
    const spread = Math.sqrt(g.nCities) * 2 * (this.cityR.reduce((a, b) => a + b, 0) / g.nCities);
    for (let c = 0; c < g.nCities; c++) {
      const a = this.rnd() * Math.PI * 2, rr = Math.sqrt(this.rnd()) * spread * 0.5;
      this.cityNodes.push({ i: c, r: this.cityR[c], x: Math.cos(a) * rr, y: Math.sin(a) * rr, vx: 0, vy: 0 });
    }
    const maxW = Math.max(1, ...g.cityEdges.map((e) => e.w));
    const links: PL[] = g.cityEdges.map((e) => ({ source: this.cityNodes[e.s], target: this.cityNodes[e.t], w: e.w }));
    const deg = new Map<PN, number>();
    for (const l of links) { deg.set(l.source, (deg.get(l.source) ?? 0) + 1); deg.set(l.target, (deg.get(l.target) ?? 0) + 1); }
    const gap = CFG.city.gap;
    this.cityCollide = forceCollide<PN>((n) => n.r + gap / 2);
    this.citySim = this.mkSim(this.cityNodes)
      .force("link", forceLink<PN, PL>(links)
        .distance((l) => l.source.r + l.target.r + gap * (1 + 2 * (1 - l.w / maxW)))
        .strength((l) => CFG.city.linkStrength / Math.min(deg.get(l.source)!, deg.get(l.target)!)))
      .force("collide", this.cityCollide)
      .force("charge", forceManyBody<PN>().strength(CFG.city.charge))
      .force("x", forceX<PN>(0).strength(CFG.city.gravity))
      .force("y", forceY<PN>(0).strength(CFG.city.gravity));
  }

  private buildDistricts() {
    const { g } = this;
    for (let d = 0; d < g.nDistricts; d++) {
      const c = g.districtCity[d];
      const a = this.rnd() * Math.PI * 2, rr = Math.sqrt(this.rnd()) * this.cityR[c] * 0.6;
      this.districtNodes.push({ i: d, r: this.districtR[d], x: Math.cos(a) * rr, y: Math.sin(a) * rr, vx: 0, vy: 0 });
    }
    for (let c = 0; c < g.nCities; c++) {
      const nodes = g.cityDistricts[c].map((d) => this.districtNodes[d]);
      const es = g.districtEdges[c];
      const maxW = Math.max(1, ...es.map((e) => e.w));
      const links: PL[] = es.map((e) => ({ source: this.districtNodes[e.s], target: this.districtNodes[e.t], w: e.w }));
      const deg = new Map<PN, number>();
      for (const l of links) { deg.set(l.source, (deg.get(l.source) ?? 0) + 1); deg.set(l.target, (deg.get(l.target) ?? 0) + 1); }
      const collide = forceCollide<PN>((n) => n.r + CFG.district.pad / 2);
      this.districtCollides.push(collide);
      const cityR = this.cityR;
      const sim = this.mkSim(nodes)
        .force("link", forceLink<PN, PL>(links)
          .distance((l) => l.source.r + l.target.r + CFG.district.pad * (1 + 2 * (1 - l.w / maxW)))
          .strength((l) => CFG.district.linkStrength / Math.min(deg.get(l.source)!, deg.get(l.target)!)))
        .force("collide", collide)
        .force("contain", forceContain(() => cityR[c]))
        .force("external", forceExternalPull((n) => this.externalBearing(n.i), CFG.district.externalPull, cityR[c] * 0.05));
      this.districtSims.push(sim);
    }
  }

  /** unit vector from this district's city toward the weighted mean of cities it links to. */
  externalBearing(d: number): [number, number] {
    const c = this.g.districtCity[d];
    const me = this.cityNodes[c];
    let x = 0, y = 0;
    for (const [c2, w] of this.g.districtExternal[d]) {
      const o = this.cityNodes[c2];
      const dx = o.x - me.x, dy = o.y - me.y, len = Math.hypot(dx, dy) || 1;
      x += (dx / len) * w; y += (dy / len) * w;
    }
    const len = Math.hypot(x, y);
    return len > 0 ? [x / len, y / len] : [0, 0];
  }

  private buildFiles() {
    const { g } = this;
    for (let f = 0; f < g.nFiles; f++) this.fileNodes.push({ i: f, r: g.fileR[f], x: 0, y: 0, vx: 0, vy: 0 });
    for (let d = 0; d < g.nDistricts; d++) {
      const R = this.districtR[d];
      const nodes = g.districtFiles[d].map((f) => this.fileNodes[f]);
      for (const n of nodes) {
        // seeded jitter inside the district disc (never rely on d3's phyllotaxis default)
        const a = this.rnd() * Math.PI * 2, rr = Math.sqrt(this.rnd()) * R * 0.7;
        n.x = Math.cos(a) * rr; n.y = Math.sin(a) * rr;
      }
      const links: PL[] = g.fileEdges[d].map(([s, t]) => ({ source: this.fileNodes[s], target: this.fileNodes[t], w: 1 }));
      const parts = this.mkFileSim(d, nodes, links);
      if (this.opts.init === "spiral") {
        // place on a golden-angle spiral at each node's own size-rank radius: near-packed, near-equilibrium start
        const sorted = [...nodes].sort((a, b) => b.r - a.r || a.i - b.i);
        sorted.forEach((n, k) => {
          const rr = parts.targets.get(n)!, a = k * 2.399963229728653 + this.rnd() * 0.01;
          n.x = Math.cos(a) * rr; n.y = Math.sin(a) * rr;
        });
      }
      this.files.push(parts);
    }
  }

  private mkFileSim(d: number, nodes: PN[], links: PL[]): FileSimParts {
    const w = CFG.file.sizeVsConnectivity;
    const targets = new Map<PN, number>();
    const parts = {} as FileSimParts;
    const districtR = this.districtR;
    const radial = forceRadial<PN>((n) => targets.get(n) ?? 0, 0, 0).strength(2 * w * CFG.file.baseStrength);
    const deg = new Map<PN, number>();
    const link = forceLink<PN, PL>(links)
      .distance((l) => l.source.r + l.target.r + CFG.file.gap / l.w)
      .strength((l) => (2 * (1 - w)) / Math.min(deg.get(l.source) ?? 1, deg.get(l.target) ?? 1));
    const collide = (this.opts.collide === "grid" ? forceGridCollide((n) => n.r + CFG.file.pad) : forceCollide<PN>((n) => n.r + CFG.file.pad)) as ForceCollide<PN>;
    Object.assign(parts, { nodes, links, link, radial, collide, targets });
    this.recomputeFileTargets(parts, d, deg);
    parts.sim = this.mkSim(nodes);
    if (this.opts.fileTicks) parts.sim.alphaDecay(1 - Math.pow(CFG.alphaMin, 1 / this.opts.fileTicks));
    parts.sim
      .force("radial", radial)
      .force("link", link)
      .force("collide", collide)
      .force("contain", forceContain(() => districtR[d]));
    (parts as any).deg = deg;
    return parts;
  }

  /** forceRadial target by size rank: largest at centre, area-uniform ranks out to 0.85 R. */
  recomputeFileTargets(p: FileSimParts, d: number, deg?: Map<PN, number>) {
    const R = this.districtR[d];
    const sorted = [...p.nodes].sort((a, b) => b.r - a.r || a.i - b.i);
    sorted.forEach((n, k) => p.targets.set(n, Math.sqrt((k + 0.5) / sorted.length) * R * 0.85));
    const dg = deg ?? ((p as any).deg as Map<PN, number>);
    dg.clear();
    for (const l of p.links) { dg.set(l.source, (dg.get(l.source) ?? 0) + 1); dg.set(l.target, (dg.get(l.target) ?? 0) + 1); }
  }

  // ---- settle ----

  static runToRest(sim: Sim, cap = 100000): number {
    let t = 0;
    while (sim.alpha() >= sim.alphaMin() && t < cap) { sim.tick(); t++; }
    return t;
  }

  settle(): { city: TierTiming; district: TierTiming; file: TierTiming; totalMs: number } {
    const run = (sims: Sim[]): TierTiming => {
      const t0 = performance.now();
      let ticks = 0, maxSimMs = 0;
      for (const s of sims) {
        const a = performance.now();
        ticks += Layout.runToRest(s);
        maxSimMs = Math.max(maxSimMs, performance.now() - a);
      }
      return { ms: performance.now() - t0, ticks, sims: sims.length, maxSimMs };
    };
    const city = run([this.citySim]);
    // bearings depend on settled city positions: re-init the external-pull force
    for (const s of this.districtSims) s.force("external", s.force("external")!);
    const district = run(this.districtSims);
    const file = run(this.files.map((f) => f.sim));
    return { city, district, file, totalMs: city.ms + district.ms + file.ms };
  }

  // ---- quality metrics ----

  quality() {
    const { g } = this;
    let overlapNodes = 0, overlapDepthSum = 0, overlapPairs = 0, outside = 0, speedSum = 0, speedRel = 0;
    for (let d = 0; d < g.nDistricts; d++) {
      const nodes = this.files[d].nodes;
      const R = this.districtR[d];
      let maxR = 0;
      for (const n of nodes) maxR = Math.max(maxR, n.r);
      const cell = 2 * maxR + 1e-6;
      const grid = new Map<string, PN[]>();
      for (const n of nodes) {
        const k = `${Math.floor(n.x / cell)},${Math.floor(n.y / cell)}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(n);
        if (Math.hypot(n.x, n.y) + n.r > R * 1.02) outside++;
        const sp = Math.hypot(n.vx, n.vy);
        speedSum += sp; speedRel += sp / n.r;
      }
      const hit = new Set<PN>();
      for (const n of nodes) {
        const cx = Math.floor(n.x / cell), cy = Math.floor(n.y / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const arr = grid.get(`${cx + dx},${cy + dy}`);
          if (!arr) continue;
          for (const m of arr) {
            if (m.i <= n.i) continue;
            const dist = Math.hypot(n.x - m.x, n.y - m.y), rs = n.r + m.r;
            if (dist < rs * 0.95) { overlapPairs++; overlapDepthSum += (rs - dist) / rs; hit.add(n); hit.add(m); }
          }
        }
      }
      overlapNodes += hit.size;
    }
    let dOverlap = 0, dOutside = 0;
    for (let c = 0; c < g.nCities; c++) {
      const ds = g.cityDistricts[c].map((d) => this.districtNodes[d]);
      for (let a = 0; a < ds.length; a++) {
        if (Math.hypot(ds[a].x, ds[a].y) + ds[a].r > this.cityR[c] * 1.02) dOutside++;
        for (let b = a + 1; b < ds.length; b++)
          if (Math.hypot(ds[a].x - ds[b].x, ds[a].y - ds[b].y) < (ds[a].r + ds[b].r) * 0.95) dOverlap++;
      }
    }
    let cOverlap = 0;
    for (let a = 0; a < g.nCities; a++) for (let b = a + 1; b < g.nCities; b++) {
      const A = this.cityNodes[a], B = this.cityNodes[b];
      if (Math.hypot(A.x - B.x, A.y - B.y) < (A.r + B.r) * 0.95) cOverlap++;
    }
    return {
      fileOverlapNodePct: (100 * overlapNodes) / g.nFiles,
      fileOverlapPairs: overlapPairs,
      fileMeanOverlapDepthPct: overlapPairs ? (100 * overlapDepthSum) / overlapPairs : 0,
      fileOutsideDistrictPct: (100 * outside) / g.nFiles,
      fileMeanResidualSpeed: speedSum / g.nFiles,
      fileMeanResidualSpeedPerRadius: speedRel / g.nFiles,
      districtOverlapPairs: dOverlap,
      districtOutsideCity: dOutside,
      cityOverlapPairs: cOverlap,
    };
  }

  checksum(): string {
    let h = 2166136261 >>> 0;
    const mix = (v: number) => { h = Math.imul(h ^ (Math.round(v * 1000) | 0), 16777619) >>> 0; };
    for (const n of this.cityNodes) { mix(n.x); mix(n.y); }
    for (const n of this.districtNodes) { mix(n.x); mix(n.y); }
    for (const n of this.fileNodes) { mix(n.x); mix(n.y); }
    return h.toString(16);
  }

  // ---- incremental add (PLAN 7.2) ----

  /**
   * Append `count` files to district d. New nodes get x/y beside a linked existing neighbour.
   * mode 'plan'   : recompute size-rank radial targets for every file (plan-literal)
   * mode 'stable' : keep existing files' radial targets; only new files get rank targets
   * Then nodes()/links() once, grow radii upward, reheat file sim, its city's district sim and the city sim to 0.3.
   * Returns the sims that were woken.
   */
  addFiles(d: number, count: number, mode: "plan" | "stable", seed = 99): Sim[] {
    const rnd = mulberry32(seed);
    const p = this.files[d];
    const c = this.g.districtCity[d];
    const existing = p.nodes.slice();
    const newNodes: PN[] = [];
    const newLinks: PL[] = [];
    for (let k = 0; k < count; k++) {
      const nb = existing[Math.floor(rnd() * rnd() * existing.length)];
      const r = fileRadiusFromU(rnd());
      const a = rnd() * Math.PI * 2, dist = nb.r + r + CFG.file.pad + rnd() * 2;
      const n: PN = { i: this.fileNodes.length, r, x: nb.x + Math.cos(a) * dist, y: nb.y + Math.sin(a) * dist, vx: 0, vy: 0 };
      this.fileNodes.push(n);
      newNodes.push(n);
      newLinks.push({ source: n, target: nb, w: 1 });
      if (rnd() < 0.5) newLinks.push({ source: n, target: existing[Math.floor(rnd() * existing.length)], w: 1 });
    }
    // grow radii upward
    p.nodes = existing.concat(newNodes);
    p.links = p.links.concat(newLinks);
    this.districtR[d] = this.radiusForDistrict(d);
    this.districtNodes[d].r = this.districtR[d];
    this.cityR[c] = this.radiusForCity(c);
    this.cityNodes[c].r = this.cityR[c];

    if (mode === "plan") this.recomputeFileTargets(p, d);
    else {
      // stable: scale nothing for existing nodes; new nodes target their rank among all
      const sorted = [...p.nodes].sort((a, b) => b.r - a.r || a.i - b.i);
      const R = this.districtR[d];
      sorted.forEach((n, k) => { if (!p.targets.has(n)) p.targets.set(n, Math.sqrt((k + 0.5) / sorted.length) * R * 0.85); });
      const dg = (p as any).deg as Map<PN, number>;
      dg.clear();
      for (const l of p.links) { dg.set(l.source, (dg.get(l.source) ?? 0) + 1); dg.set(l.target, (dg.get(l.target) ?? 0) + 1); }
    }

    // one nodes() and one links() call
    p.sim.nodes(p.nodes); // re-initialises every force (radial targets, collide radii, link with old links)
    p.link.links(p.links); // re-initialise link with new links (strength/distance recomputed)
    p.sim.alpha(Math.max(p.sim.alpha(), CFG.reheat));

    // propagate space upward: collide radii re-read on initialize
    const dsim = this.districtSims[c];
    this.districtCollides[c].radius(this.districtCollides[c].radius());
    dsim.alpha(Math.max(dsim.alpha(), CFG.reheat));
    this.cityCollide.radius(this.cityCollide.radius());
    this.citySim.alpha(Math.max(this.citySim.alpha(), CFG.reheat));
    return [this.citySim, dsim, p.sim];
  }
}

export function snapshot(nodes: PN[]): Float64Array {
  const a = new Float64Array(nodes.length * 2);
  nodes.forEach((n, k) => { a[2 * k] = n.x; a[2 * k + 1] = n.y; });
  return a;
}
export function displacement(nodes: PN[], before: Float64Array) {
  let sum = 0, max = 0;
  const n = before.length / 2;
  for (let k = 0; k < n; k++) {
    const d = Math.hypot(nodes[k].x - before[2 * k], nodes[k].y - before[2 * k + 1]);
    sum += d; if (d > max) max = d;
  }
  return { mean: n ? sum / n : 0, max, n };
}

/**
 * Spatial-hash collide with d3's forceCollide semantics (one iteration, predicted positions, radius^2 mass split).
 * Each node is inserted into every cell its disc touches; a pair is resolved only in the cell holding the
 * lower-left corner of the intersection of their bounding boxes, so each pair is visited once.
 */
export function forceGridCollide(radius: (n: PN) => number, strength = 1) {
  let nodes: PN[] = [];
  let radii = new Float64Array(0);
  let cell = 1;
  const grid = new Map<number, number[]>();
  const used: number[][] = [];
  function force() {
    const n = nodes.length;
    const px = new Float64Array(n), py = new Float64Array(n);
    for (const a of used) a.length = 0;
    used.length = 0;
    const inv = 1 / cell;
    for (let i = 0; i < n; i++) {
      const nd = nodes[i], r = radii[i];
      const x = (px[i] = nd.x + nd.vx), y = (py[i] = nd.y + nd.vy);
      const cx0 = Math.floor((x - r) * inv), cx1 = Math.floor((x + r) * inv);
      const cy0 = Math.floor((y - r) * inv), cy1 = Math.floor((y + r) * inv);
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const key = (cx + 32768) * 65536 + (cy + 32768);
        let arr = grid.get(key);
        if (!arr) grid.set(key, (arr = []));
        if (arr.length === 0) used.push(arr);
        arr.push(i);
      }
    }
    for (const [key, arr] of grid) {
      if (arr.length < 2) continue;
      const cx = Math.floor(key / 65536) - 32768, cy = (key % 65536) - 32768;
      for (let p = 0; p < arr.length; p++) {
        const i = arr[p], ri = radii[i], ni = nodes[i];
        for (let q = p + 1; q < arr.length; q++) {
          const j = arr[q], rj = radii[j];
          const r = ri + rj;
          let x = px[i] - px[j], y = py[i] - py[j];
          // only the owning cell resolves the pair
          const ox = Math.max(px[i] - ri, px[j] - rj), oy = Math.max(py[i] - ri, py[j] - rj);
          if (Math.floor(ox * inv) !== cx || Math.floor(oy * inv) !== cy) continue;
          let l = x * x + y * y;
          if (l >= r * r) continue;
          const nj = nodes[j];
          if (x === 0) { x = (i - j) * 1e-6; l += x * x; }
          if (y === 0) { y = (i - j) * 1e-6; l += y * y; }
          l = Math.sqrt(l);
          l = ((r - l) / l) * strength;
          x *= l; y *= l;
          const ri2 = ri * ri, rj2 = rj * rj, w = rj2 / (ri2 + rj2);
          ni.vx += x * w; ni.vy += y * w;
          nj.vx -= x * (1 - w); nj.vy -= y * (1 - w);
        }
      }
    }
    // drop empty buckets occasionally to bound memory
    if (grid.size > 4 * n + 1024) grid.clear();
  }
  force.initialize = (ns: PN[]) => {
    nodes = ns;
    radii = Float64Array.from(ns, radius);
    const sorted = Array.from(radii).sort((a, b) => a - b);
    cell = 2 * (sorted[Math.floor(sorted.length * 0.75)] ?? 1); // ~p75 diameter: big nodes span several cells
  };
  (force as any).radius = (r?: (n: PN) => number) => { if (r) { radius = r; force.initialize(nodes); return force; } return radius; };
  return force;
}
