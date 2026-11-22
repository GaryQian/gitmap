// Jiggle: a display-only spring layer (PLAN.md §7.4). Each active sphere has an offset and a
// velocity on the ground plane, pulled back to rest by a damped spring. Layout positions are never
// read or written here; offsets go to the renderer as nudges. Pure: no DOM, no WebGL.

export interface Spring {
  /** Natural frequency, rad/s. */
  omega: number;
  /** Damping ratio, below 1 (it wobbles before it settles). */
  zeta: number;
}

/**
 * The spring that brings a sphere from the worst case (at the clamp, moving at the strongest kick)
 * to rest within `settleMs`. "Rest" is an offset and speed below `restFraction` of those limits.
 * For such a start the motion stays under √(2 / (1 − ζ)) · e^(−ζωt) of the limits, which fixes ω.
 */
export function springFor(settleMs: number, damping: number, restFraction: number): Spring {
  const zeta = Math.min(0.95, Math.max(0.05, damping));
  const seconds = Math.max(0.05, settleMs / 1000) * 0.9; // a little early, so a frame of slack remains
  const decay = Math.log(Math.sqrt(2 / (1 - zeta)) / Math.max(1e-4, Math.min(0.5, restFraction))) / seconds;
  return { omega: decay / zeta, zeta };
}

/**
 * Exact step of the damped spring over `dt` seconds, as a 2×2 matrix on [offset, velocity]:
 * offset' = m[0]·offset + m[1]·velocity, velocity' = m[2]·offset + m[3]·velocity. Stable for any dt.
 */
export function springStep(spring: Spring, dt: number): [number, number, number, number] {
  const { omega, zeta } = spring;
  const sigma = zeta * omega, wd = omega * Math.sqrt(1 - zeta * zeta);
  const e = Math.exp(-sigma * dt), c = Math.cos(wd * dt), s = Math.sin(wd * dt);
  return [e * (c + (sigma / wd) * s), e * (s / wd), -e * ((omega * omega) / wd) * s, e * (c - (sigma / wd) * s)];
}

/**
 * Share of an impulse a neighbour receives: all of `share` when the two spheres touch or overlap,
 * fading to nothing when their centres are `reach` times the sum of their radii apart.
 */
export function neighbourShare(distance: number, ra: number, rb: number, share: number, reach: number): number {
  const touch = ra + rb, limit = touch * reach;
  if (!(distance < limit)) return 0;
  if (distance <= touch) return share;
  return (share * (limit - distance)) / (limit - touch);
}

export interface JiggleParams {
  /** config.interaction.jiggleSettleMs */
  settleMs: number;
  /** config.interaction.jiggleMax: the largest offset, in sphere radii. */
  maxRadii: number;
  damping: number;
  restFraction: number;
  /** Spheres integrated at once; a kick past this is dropped unless forced. */
  maxActive: number;
}

interface Body { r: number; x: number; z: number; vx: number; vz: number }

/** The active spheres and their springs. Nothing is stored, and `step` does nothing, when none is active. */
export class JiggleField {
  readonly spring: Spring;
  private bodies = new Map<number, Body>();

  constructor(private params: JiggleParams) {
    this.spring = springFor(params.settleMs, params.damping, params.restFraction);
  }

  /** Number of spheres being integrated. */
  get size(): number { return this.bodies.size; }
  has(slot: number): boolean { return this.bodies.has(slot); }
  slots(): number[] { return [...this.bodies.keys()]; }

  /** Largest offset of a sphere of radius r, world units. */
  maxOffset(r: number): number { return this.params.maxRadii * r; }
  /** Fastest a sphere of radius r is ever left moving by kicks, world units per second. */
  maxSpeed(r: number): number { return this.maxOffset(r) * this.spring.omega; }

  /**
   * Add velocity (world units per second) to the sphere in `slot`, of radius `r`. Returns false when
   * nothing was started: the kick is too faint to see, or the field is full and `force` is off.
   */
  kick(slot: number, r: number, vx: number, vz: number, force = false): boolean {
    if (!(r > 0) || !Number.isFinite(vx) || !Number.isFinite(vz)) return false;
    const cap = this.maxSpeed(r);
    let b = this.bodies.get(slot);
    if (!b) {
      if (Math.hypot(vx, vz) < cap * this.params.restFraction) return false;
      if (!force && this.bodies.size >= this.params.maxActive) return false;
      b = { r, x: 0, z: 0, vx: 0, vz: 0 };
      this.bodies.set(slot, b);
    }
    b.r = r;
    b.vx += vx; b.vz += vz;
    const speed = Math.hypot(b.vx, b.vz);
    if (speed > cap) { b.vx *= cap / speed; b.vz *= cap / speed; }
    return true;
  }

  /**
   * Advance every active sphere by `dt` seconds and report its offset. A sphere that has come to rest
   * is reported once more at (0, 0) and forgotten.
   */
  step(dt: number, out: (slot: number, x: number, z: number) => void): void {
    if (!this.bodies.size) return;
    const [xx, xv, vx, vv] = springStep(this.spring, Math.max(0, dt));
    const eps = this.params.restFraction;
    for (const [slot, b] of this.bodies) {
      let x = xx * b.x + xv * b.vx, z = xx * b.z + xv * b.vz;
      let ux = vx * b.x + vv * b.vx, uz = vx * b.z + vv * b.vz;
      const limit = this.maxOffset(b.r);
      const d = Math.hypot(x, z);
      if (d > limit) {
        // held at the clamp: the outward part of the velocity is lost
        const nx = x / d, nz = z / d, outward = ux * nx + uz * nz;
        x = nx * limit; z = nz * limit;
        if (outward > 0) { ux -= outward * nx; uz -= outward * nz; }
      }
      if (d < limit * eps && Math.hypot(ux, uz) < this.maxSpeed(b.r) * eps) {
        this.bodies.delete(slot);
        out(slot, 0, 0);
        continue;
      }
      b.x = x; b.z = z; b.vx = ux; b.vz = uz;
      out(slot, x, z);
    }
  }

  /** Forget one sphere, reporting it at rest. */
  drop(slot: number, out: (slot: number, x: number, z: number) => void): void {
    if (this.bodies.delete(slot)) out(slot, 0, 0);
  }

  /** Forget every sphere, reporting each at rest. */
  clear(out: (slot: number, x: number, z: number) => void): void {
    for (const slot of this.bodies.keys()) out(slot, 0, 0);
    this.bodies.clear();
  }
}

/** A small spatial hash over the units of one district, in the district's local coordinates. */
export class NeighbourHash {
  private cells = new Map<number, number[]>();

  /** `xz` holds [x, z] per slot; `slots[from .. to)` are hashed into square cells of side `cell`. */
  constructor(slots: ArrayLike<number>, from: number, to: number, private xz: ArrayLike<number>, readonly cell: number) {
    for (let i = from; i < to; i++) {
      const s = slots[i];
      if (2 * s + 1 >= xz.length) continue;
      const k = this.key(Math.floor(xz[2 * s] / cell), Math.floor(xz[2 * s + 1] / cell));
      const list = this.cells.get(k);
      if (list) list.push(s); else this.cells.set(k, [s]);
    }
  }

  private key(ix: number, iz: number): number {
    return ((ix + 0x8000) & 0xffff) * 0x10000 + ((iz + 0x8000) & 0xffff);
  }

  /** Call `fn` for every hashed slot whose position lies within `radius` of (x, z). */
  near(x: number, z: number, radius: number, fn: (slot: number, dx: number, dz: number, distance: number) => void): void {
    const { cell, xz } = this;
    const x0 = Math.floor((x - radius) / cell), x1 = Math.floor((x + radius) / cell);
    const z0 = Math.floor((z - radius) / cell), z1 = Math.floor((z + radius) / cell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.cells.get(this.key(ix, iz));
        if (!list) continue;
        for (const s of list) {
          const dx = xz[2 * s] - x, dz = xz[2 * s + 1] - z;
          const distance = Math.hypot(dx, dz);
          if (distance <= radius) fn(s, dx, dz, distance);
        }
      }
    }
  }
}
