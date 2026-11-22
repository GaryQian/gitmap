// Territory tunables that have no key in config.json yet (see "Requested changes" in the 2E report).
export const TERRITORY_LOCAL = {
  /** Side of the square footprint texture, texels. Low on purpose: the ground only needs soft shapes. */
  resolution: 1024,
  /** Margin around the map's bounding circle, as a share of its radius plus a fixed number of world units. */
  margin: 0.12,
  marginWorld: 60,
  /** A sphere's footprint reaches this many radii, plus a fixed skirt (world units) so small files still join up. */
  footprintRadii: 3.0,
  footprintSkirt: 4.0,
  /** A district also lays down one wide, faint disc (its territory radius × this, plus the skirt): it joins its files into one shape. */
  districtDisc: 1.12,
  districtSkirt: 10.0,
  districtWeight: 0.34,
  /** A city lays down one faint disc of its own radius (× this, plus the skirt): the ground its districts stand on. */
  cityDisc: 1.0,
  citySkirt: 14.0,
  cityWeight: 0.1,
  /** Density levels: where the fill starts and saturates, and the two contour levels (city boundary, district boundary). */
  fill: [0.02, 0.7],
  contourOuter: 0.05,
  contourInner: 0.22,
  /** Strengths in dark mode (added light) and light mode (alpha): fill, city contour, district contour, Voronoi border. */
  dark: { fill: 0.11, outer: 0.30, inner: 0.20, border: 0.22 },
  light: { fill: 0.26, outer: 0.5, inner: 0.3, border: 0.34 },
  /** Voronoi border width, device pixels, and the world width it never drops below. */
  borderPx: 1.25,
  borderWorld: 0.35,
  /** Seconds for the territories to fade in once the reveal has started. */
  fadeIn: 1.2,
  tint: {
    hueStart: 0.58,
    saturation: 0.55,
    lightness: 0.56,
    /** Largest hue and lightness shift of a district against its city, 0..1. */
    districtHue: 0.035,
    districtLightness: 0.07,
  },
} as const;
