// Level of detail for edges by camera distance (PLAN.md §8.3). Pure.
import { EDGE_LOCAL } from './tunables';

/** Typical territory radii on the current map, world units. */
export interface LodScale { city: number; district: number }

/** How strongly each level is drawn, 0..1. They cross-fade; they never pop. */
export interface LodMix {
  /** Far: one ribbon per city pair. */
  city: number;
  /** Mid: district↔district ribbons for cities in view. */
  district: number;
  /** Near: ambient file↔file edges for districts in view. */
  file: number;
}

export interface LodContent {
  /** There is at least one city↔city ribbon. */
  city: boolean;
  /** There is at least one district↔district ribbon. */
  district: boolean;
}

const smooth = (lo: number, hi: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/** Camera distances at which far hands over to mid, and mid to near. */
export function lodThresholds(scale: LodScale, t: typeof EDGE_LOCAL.lod = EDGE_LOCAL.lod): { far: number; near: number } {
  const far = Math.max(1e-3, scale.city * t.cityFar);
  const near = Math.max(1e-3, Math.min(scale.district * t.districtNear, far * t.nearMaxShare));
  return { far, near };
}

/**
 * The mix of levels at a camera distance. A level with nothing to draw hands its range to the next
 * finer one, so a one-city repo shows district ribbons from afar and a one-district repo shows files.
 */
export function lodMix(distance: number, scale: LodScale, content: LodContent = { city: true, district: true }, t: typeof EDGE_LOCAL.lod = EDGE_LOCAL.lod): LodMix {
  const th = lodThresholds(scale, t);
  const x = Math.log(Math.max(distance, 1e-6)), h = Math.log(t.band);
  const far = content.city ? smooth(Math.log(th.far) - h, Math.log(th.far) + h, x) : 0;
  // with no district ribbons, files run all the way out to where city ribbons begin
  const nearAt = content.district ? th.near : th.far;
  const near = content.district || content.city ? 1 - smooth(Math.log(nearAt) - h, Math.log(nearAt) + h, x) : 1;
  return { city: far, district: content.district ? (1 - far) * (1 - near) : 0, file: content.district ? near : Math.min(near, 1 - far) };
}

/** The ground circle treated as "in view": centred on the camera target. */
export function viewCircle(target: { x: number; z: number }, distance: number, t: typeof EDGE_LOCAL.lod = EDGE_LOCAL.lod): { x: number; z: number; r: number } {
  return { x: target.x, z: target.z, r: distance * t.viewRadius };
}

/** True when a territory circle overlaps the view circle. */
export function inView(view: { x: number; z: number; r: number }, x: number, z: number, r: number): boolean {
  const dx = x - view.x, dz = z - view.z, reach = view.r + r;
  return dx * dx + dz * dz <= reach * reach;
}

/** True when the camera moved enough since `last` that the in-view sets should be chosen again. */
export function viewChanged(last: { x: number; z: number; distance: number } | null, now: { x: number; z: number; distance: number }, t: typeof EDGE_LOCAL.lod = EDGE_LOCAL.lod): boolean {
  if (!last) return true;
  const zoom = now.distance > last.distance ? now.distance / last.distance : last.distance / now.distance;
  return zoom > t.reselectZoom || Math.hypot(now.x - last.x, now.z - last.z) > t.reselectMove * Math.min(now.distance, last.distance);
}
