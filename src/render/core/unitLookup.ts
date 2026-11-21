// Per-unit lookup textures, indexed by unit slot, for shaders that reach a unit by slot instead of
// by instance (edge endpoints, particle hosts): uUnitInfo = [radius, district slot, city slot, glow],
// uUnitColor = [r, g, b, alive]. Written only by the core's batch projection.
import * as THREE from 'three';
import type { Config } from '../../config';
import { hexToRgb, languageColor } from '../../shared';
import { SLOT_TEX_WIDTH, makeSlotTexture, slotTexHeight } from './positions';
import type { UnitReader } from './unitRow';

interface Uniforms { uUnitInfo: { value: THREE.DataTexture }; uUnitColor: { value: THREE.DataTexture } }

export class UnitLookup {
  /** [radius, district slot, city slot, glow] per unit slot; radius 0 for an empty slot. */
  info!: Float32Array;
  /** [r, g, b, alive] per unit slot, 0..255. */
  color!: Uint8Array;
  capacity = 0;
  private infoTex: THREE.DataTexture | null = null;
  private colorTex: THREE.DataTexture | null = null;
  private colors = new Map<string, [number, number, number]>();

  constructor(private uniforms: Uniforms, private visual: Config['visual'], capacity: number) {
    this.ensure(Math.max(1, capacity));
  }

  /** Grow to hold at least `capacity` slots, keeping contents. */
  ensure(capacity: number): void {
    if (capacity <= this.capacity) return;
    const h = slotTexHeight(Math.max(capacity, this.capacity * 2));
    const info = new Float32Array(SLOT_TEX_WIDTH * h * 4), color = new Uint8Array(SLOT_TEX_WIDTH * h * 4);
    if (this.capacity) { info.set(this.info); color.set(this.color); }
    this.info = info; this.color = color; this.capacity = SLOT_TEX_WIDTH * h;
    this.infoTex?.dispose(); this.colorTex?.dispose();
    this.infoTex = makeSlotTexture(info, h, THREE.RGBAFormat);
    this.colorTex = makeSlotTexture(color, h, THREE.RGBAFormat);
    this.uniforms.uUnitInfo.value = this.infoTex;
    this.uniforms.uUnitColor.value = this.colorTex;
  }

  private rgb(lang: string): [number, number, number] {
    let c = this.colors.get(lang);
    if (!c) {
      const [r, g, b] = hexToRgb(languageColor(lang, this.visual));
      this.colors.set(lang, (c = [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]));
    }
    return c;
  }

  /** Write or clear one slot from the replica. */
  write(slot: number, read: UnitReader): void {
    this.ensure(slot + 1);
    const row = read(slot);
    const i = 4 * slot;
    if (!row) {
      this.info.fill(0, i, i + 4); this.color.fill(0, i, i + 4);
    } else {
      this.info[i] = row.radius; this.info[i + 1] = row.district; this.info[i + 2] = row.city; this.info[i + 3] = row.glow;
      const c = this.rgb(row.lang);
      this.color[i] = c[0]; this.color[i + 1] = c[1]; this.color[i + 2] = c[2]; this.color[i + 3] = 255;
    }
    this.infoTex!.needsUpdate = true;
    this.colorTex!.needsUpdate = true;
  }

  /** Rewrite every slot below `capacity` from the replica and clear the rest. */
  rebuild(capacity: number, read: UnitReader): void {
    this.ensure(capacity);
    this.info.fill(0); this.color.fill(0);
    for (let s = 0; s < capacity; s++) this.write(s, read);
    this.infoTex!.needsUpdate = true;
    this.colorTex!.needsUpdate = true;
  }

  dispose(): void {
    this.infoTex?.dispose(); this.colorTex?.dispose();
    this.infoTex = this.colorTex = null;
  }
}
