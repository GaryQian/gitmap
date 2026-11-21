// Position data textures: unit [x, z], district [x, z, r, 0], city [x, z, r, 0], indexed by slot.
// Uploaded from PositionBuffers when the generation counters change. World position is composed in
// the vertex shader (GLSL_POSITIONS in glsl.ts): city + district + unit.
import * as THREE from 'three';
import { GEN_ANY, GEN_CITY, GEN_DISTRICT0, GEN_HOT, GEN_REV, type PositionBuffers } from '../../contracts/physics';

/** Width of every slot-indexed data texture. Must stay a power of two (shaders use shifts). */
export const SLOT_TEX_WIDTH = 1024;
export const SLOT_TEX_SHIFT = 10;

export function slotTexHeight(slots: number): number {
  return Math.max(1, Math.ceil(slots / SLOT_TEX_WIDTH));
}

export function makeSlotTexture(data: Float32Array | Uint8Array, height: number, format: THREE.PixelFormat): THREE.DataTexture {
  const type = data instanceof Float32Array ? THREE.FloatType : THREE.UnsignedByteType;
  const tex = new THREE.DataTexture(data, SLOT_TEX_WIDTH, height, format, type);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** The counters the renderer has already acted on. */
export interface GenSeen { any: number; rev: number; city: number; districts: Int32Array }

export function newGenSeen(): GenSeen {
  return { any: -1, rev: -1, city: -1, districts: new Int32Array(0) };
}

/**
 * Compare the buffer's generation counters with what was last seen, and record the new values.
 * `city`: city rows changed. `district`: some district's row, or its units' rows, changed.
 * When GEN_ANY moved but no finer counter did, everything is reported as changed.
 */
export function diffGenerations(gen: Int32Array, seen: GenSeen): { any: boolean; city: boolean; district: boolean; rev: boolean } {
  const any = Atomics.load(gen, GEN_ANY);
  const rev = Atomics.load(gen, GEN_REV);
  const out = { any: any !== seen.any, city: false, district: false, rev: rev !== seen.rev };
  seen.rev = rev;
  if (!out.any) return out;
  seen.any = any;
  const city = Atomics.load(gen, GEN_CITY);
  if (city !== seen.city) { out.city = true; seen.city = city; }
  const n = gen.length - GEN_DISTRICT0;
  if (seen.districts.length !== n) { seen.districts = new Int32Array(n).fill(-1); }
  for (let d = 0; d < n; d++) {
    const g = Atomics.load(gen, GEN_DISTRICT0 + d);
    if (g !== seen.districts[d]) { out.district = true; seen.districts[d] = g; }
  }
  if (!out.city && !out.district) out.city = out.district = true;
  return out;
}

/** Copy [x, z, r] rows into [x, z, r, 0] texels. */
export function copyXzr(src: Float32Array, dst: Float32Array): void {
  const n = Math.min(Math.floor(src.length / 3), Math.floor(dst.length / 4));
  for (let i = 0; i < n; i++) {
    dst[4 * i] = src[3 * i];
    dst[4 * i + 1] = src[3 * i + 1];
    dst[4 * i + 2] = src[3 * i + 2];
  }
}

interface Uniforms { uPosUnit: { value: THREE.DataTexture }; uPosDistrict: { value: THREE.DataTexture }; uPosCity: { value: THREE.DataTexture } }

export class PositionTextures {
  buffers: PositionBuffers;
  private unitData!: Float32Array;
  private districtData!: Float32Array;
  private cityData!: Float32Array;
  private seen = newGenSeen();
  private textures: THREE.DataTexture[] = [];

  constructor(buffers: PositionBuffers, private uniforms: Uniforms) {
    this.buffers = buffers;
    this.allocate();
  }

  private allocate(): void {
    for (const t of this.textures) t.dispose();
    const b = this.buffers;
    const hu = slotTexHeight(b.unit.length / 2), hd = slotTexHeight(b.district.length / 3), hc = slotTexHeight(b.city.length / 3);
    this.unitData = new Float32Array(SLOT_TEX_WIDTH * hu * 2);
    this.districtData = new Float32Array(SLOT_TEX_WIDTH * hd * 4);
    this.cityData = new Float32Array(SLOT_TEX_WIDTH * hc * 4);
    const unit = makeSlotTexture(this.unitData, hu, THREE.RGFormat);
    const district = makeSlotTexture(this.districtData, hd, THREE.RGBAFormat);
    const city = makeSlotTexture(this.cityData, hc, THREE.RGBAFormat);
    this.textures = [unit, district, city];
    this.uniforms.uPosUnit.value = unit;
    this.uniforms.uPosDistrict.value = district;
    this.uniforms.uPosCity.value = city;
    this.seen = newGenSeen();
  }

  /** Physics reallocated its buffers. */
  setBuffers(buffers: PositionBuffers): void {
    const same = buffers.unit.length === this.buffers.unit.length && buffers.district.length === this.buffers.district.length
      && buffers.city.length === this.buffers.city.length;
    this.buffers = buffers;
    if (same) this.seen = newGenSeen(); else this.allocate();
  }

  /** Upload what changed since the last call. Returns true when anything was uploaded or physics applied a new revision. */
  sync(): boolean {
    const b = this.buffers;
    const diff = diffGenerations(b.gen, this.seen);
    if (diff.city) {
      copyXzr(b.city, this.cityData);
      this.textures[2].needsUpdate = true;
    }
    if (diff.district) {
      copyXzr(b.district, this.districtData);
      this.textures[1].needsUpdate = true;
      this.unitData.set(b.unit.length <= this.unitData.length ? b.unit : b.unit.subarray(0, this.unitData.length));
      this.textures[0].needsUpdate = true;
    }
    return diff.any || diff.rev;
  }

  /** The model revision physics has applied. */
  rev(): number { return Atomics.load(this.buffers.gen, GEN_REV); }
  /** True while any simulation is hot. */
  hot(): boolean { return Atomics.load(this.buffers.gen, GEN_HOT) > 0; }

  dispose(): void {
    for (const t of this.textures) t.dispose();
    this.textures = [];
  }
}
