// One instanced buffer of edges: the arc strip geometry plus per-instance attributes (see shaders.ts).
// A focus buffer carries a second geometry over the same instances, for the arrival flashes.
import * as THREE from 'three';

const ENDS = 4, W = 4, FX = 4, COLOR = 3;

export interface EdgeInstance {
  /** aEnds */
  e0: number; e1: number; e2: number; e3: number;
  strength: number; brightness: number; phase: number; share: number;
  birth: number; hideAt: number; nova: number;
}

function stripBase(segments: number): { position: THREE.BufferAttribute; index: number[] } {
  const pos: number[] = [], index: number[] = [];
  for (let s = 0; s <= segments; s++) {
    pos.push(s / segments, -1, 0, s / segments, 1, 0);
    if (s < segments) { const b = s * 2; index.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  }
  return { position: new THREE.BufferAttribute(new Float32Array(pos), 3), index };
}

export class EdgeBuffer {
  capacity = 0;
  count = 0;
  ends = new Float32Array(0);
  w = new Float32Array(0);
  fx = new Float32Array(0);
  ca: Float32Array | null = null;
  cb: Float32Array | null = null;
  strip: THREE.InstancedBufferGeometry | null = null;
  flash: THREE.InstancedBufferGeometry | null = null;
  private attrs: THREE.InstancedBufferAttribute[] = [];
  private stripMeshes: THREE.Mesh[] = [];
  private flashMeshes: THREE.Mesh[] = [];

  constructor(private segments: number, private ribbon: boolean, private withFlash: boolean, initial = 256) {
    this.allocate(initial);
  }

  /** Meshes whose geometry follows this buffer when it is reallocated. */
  attach(mesh: THREE.Mesh, kind: 'strip' | 'flash'): void {
    (kind === 'strip' ? this.stripMeshes : this.flashMeshes).push(mesh);
    mesh.geometry = (kind === 'strip' ? this.strip : this.flash)!;
  }

  private allocate(capacity: number): void {
    this.strip?.dispose();
    this.flash?.dispose();
    this.capacity = capacity;
    this.ends = new Float32Array(capacity * ENDS);
    this.w = new Float32Array(capacity * W);
    this.fx = new Float32Array(capacity * FX);
    this.ca = this.ribbon ? new Float32Array(capacity * COLOR) : null;
    this.cb = this.ribbon ? new Float32Array(capacity * COLOR) : null;
    const named: [string, Float32Array | null, number][] = [['aEnds', this.ends, ENDS], ['aW', this.w, W], ['aFx', this.fx, FX], ['aCa', this.ca, COLOR], ['aCb', this.cb, COLOR]];
    this.attrs = [];
    const instanced: [string, THREE.InstancedBufferAttribute][] = [];
    for (const [name, data, size] of named) {
      if (!data) continue;
      const attr = new THREE.InstancedBufferAttribute(data, size);
      attr.setUsage(THREE.DynamicDrawUsage);
      this.attrs.push(attr);
      instanced.push([name, attr]);
    }
    const make = (position: THREE.BufferAttribute, index: number[]) => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', position);
      g.setIndex(index);
      for (const [name, attr] of instanced) g.setAttribute(name, attr);
      g.instanceCount = 0;
      return g;
    };
    const base = stripBase(this.segments);
    this.strip = make(base.position, base.index);
    for (const m of this.stripMeshes) m.geometry = this.strip;
    if (this.withFlash) {
      this.flash = make(new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3), [0, 1, 2, 0, 2, 3]);
      for (const m of this.flashMeshes) m.geometry = this.flash;
    }
  }

  /** Make room for `n` instances. Contents are not kept: a buffer is always refilled from its start. */
  ensure(n: number): void {
    if (n <= this.capacity) return;
    let capacity = Math.max(256, this.capacity);
    while (capacity < n) capacity *= 2;
    this.allocate(capacity);
  }

  set(i: number, v: EdgeInstance): void {
    const e = i * ENDS;
    this.ends[e] = v.e0; this.ends[e + 1] = v.e1; this.ends[e + 2] = v.e2; this.ends[e + 3] = v.e3;
    this.w[e] = v.strength; this.w[e + 1] = v.brightness; this.w[e + 2] = v.phase; this.w[e + 3] = v.share;
    this.fx[e] = v.birth; this.fx[e + 1] = v.hideAt; this.fx[e + 2] = v.nova; this.fx[e + 3] = 0;
  }

  setColors(i: number, a: readonly number[], b: readonly number[]): void {
    if (!this.ca || !this.cb) return;
    const c = i * COLOR;
    this.ca[c] = a[0]; this.ca[c + 1] = a[1]; this.ca[c + 2] = a[2];
    this.cb[c] = b[0]; this.cb[c + 1] = b[1]; this.cb[c + 2] = b[2];
  }

  /** Upload the first `count` instances and draw that many. */
  commit(count: number): void {
    this.count = count;
    for (const attr of this.attrs) {
      attr.clearUpdateRanges();
      if (count > 0) { attr.addUpdateRange(0, count * attr.itemSize); attr.needsUpdate = true; }
    }
    if (this.strip) this.strip.instanceCount = count;
    if (this.flash) this.flash.instanceCount = count;
  }

  dispose(): void {
    this.strip?.dispose();
    this.flash?.dispose();
    this.strip = this.flash = null;
    this.stripMeshes.length = this.flashMeshes.length = 0;
  }
}
