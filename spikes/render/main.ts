// gitmap M0 spike 4: render N impostor spheres + instanced arc edges + GPU particles + ground/territory.
// URL params: n, edges, particles, terr (0/1), terrHot (re-render territory every frame), fd (gl_FragDepth on spheres),
// orbit (0/1), dist (camera distance multiplier), seg (arc segments), dpr, finish (time render+gl.finish), seed.
import * as THREE from 'three';

const qs = new URLSearchParams(location.search);
const num = (k: string, d: number) => (qs.has(k) ? Number(qs.get(k)) : d);
const N = num('n', 10000);
const EDGE_BUDGET = num('edges', 1500); // ambient connections only; hovered and selected files draw their own
const PARTICLES = num('particles', 4000);
const TERR = num('terr', 1) === 1;
const TERR_HOT = num('terrHot', 0) === 1;
const FRAGDEPTH = num('fd', 0) === 1; // unused by the star look: discs sort by their centre depth
const ORBIT = num('orbit', 1) === 1;
const DIST = num('dist', 1);
const SEG = num('seg', 16);
const DPR = num('dpr', Math.min(devicePixelRatio, 2));
const FINISH = num('finish', 0) === 1;
const SEED = num('seed', 1);
const DARK = (qs.get('mode') ?? 'dark') !== 'light'; // dark is the default appearance
const CORONA = num('corona', 1) === 1;
const POOLS = num('pools', 1) === 1;
const WISPS = num('wisps', 1) === 1;
const CAMH = num('camh', 0.55);   // camera height as a fraction of its distance
const LOOKX = num('lx', 0), LOOKZ = num('lz', 0); // look-at offset, as a fraction of the map extent
const ANGLE = num('angle', 0.6);  // fixed orbit angle when orbit=0

// ---------- seeded RNG ----------
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED * 7919 + 13);
const gauss = () => { const u = 1 - rng(), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
function cdfPick(cdf: Float64Array) { const x = rng() * cdf[cdf.length - 1]; let lo = 0, hi = cdf.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < x) lo = m + 1; else hi = m; } return lo; }
const cdfOf = (w: ArrayLike<number>) => { const c = new Float64Array(w.length); let s = 0; for (let i = 0; i < w.length; i++) { s += w[i]; c[i] = s; } return c; };

// ---------- synthetic repo ----------
const t0 = performance.now();
const NCITY = 12;
const LANG = [[0.18, 0.45, 0.80], [0.92, 0.62, 0.00], [0.20, 0.62, 0.35], [0.85, 0.20, 0.42], [0.00, 0.63, 0.80], [0.86, 0.38, 0.15], [0.55, 0.27, 0.68], [0.42, 0.30, 0.90]];
const CITY_TINT = Array.from({ length: NCITY }, (_, c) => new THREE.Color().setHSL(c / NCITY, 0.55, 0.55));

const cityW = Array.from({ length: NCITY }, () => Math.exp(gauss() * 0.6));
const cityCdf = cdfOf(cityW);
const distOfCity: number[][] = []; // global district ids per city
const distCity: number[] = [];
const distCdf: Float64Array[] = [];
for (let c = 0; c < NCITY; c++) {
  const nd = 6 + Math.floor(rng() * 7);
  const ids: number[] = []; const w: number[] = [];
  for (let d = 0; d < nd; d++) { ids.push(distCity.length); distCity.push(c); w.push(Math.exp(gauss() * 0.7)); }
  distOfCity.push(ids); distCdf.push(cdfOf(w));
}
const ND = distCity.length;
const fileCity = new Uint8Array(N), fileDist = new Uint16Array(N), fileLang = new Uint8Array(N);
const lines = new Float32Array(N), attract = new Float32Array(N);
const distLang = Array.from({ length: ND }, () => Math.floor(rng() * LANG.length));
const distMembers: number[][] = Array.from({ length: ND }, () => []);
const cityMembers: number[][] = Array.from({ length: NCITY }, () => []);
for (let i = 0; i < N; i++) {
  const c = cdfPick(cityCdf); const d = distOfCity[c][cdfPick(distCdf[c])];
  fileCity[i] = c; fileDist[i] = d; distMembers[d].push(i); cityMembers[c].push(i);
  fileLang[i] = rng() < 0.8 ? distLang[d] : Math.floor(rng() * LANG.length);
  lines[i] = Math.min(20000, Math.max(3, Math.exp(4.6 + 1.1 * gauss())));
  attract[i] = Math.exp(1.3 * gauss());
}
// edges: ~10 per file, 65% same district, 25% same city, 10% anywhere; targets by tournament on attractiveness
const avgDeg = 10;
const EMAX = N * avgDeg * 2;
let E = 0;
const eSrc = new Uint32Array(EMAX), eDst = new Uint32Array(EMAX), eW = new Float32Array(EMAX);
const indeg = new Float32Array(N);
const pickIn = (arr: number[]) => { let best = arr[Math.floor(rng() * arr.length)]; for (let k = 0; k < 2; k++) { const c = arr[Math.floor(rng() * arr.length)]; if (attract[c] > attract[best]) best = c; } return best; };
const all: number[] = Array.from({ length: N }, (_, i) => i);
for (let i = 0; i < N; i++) {
  const deg = 1 + Math.floor(rng() * (2 * avgDeg - 1));
  for (let k = 0; k < deg && E < EMAX; k++) {
    const r = rng();
    const pool = r < 0.65 ? distMembers[fileDist[i]] : r < 0.9 ? cityMembers[fileCity[i]] : all;
    const j = pickIn(pool); if (j === i) continue;
    eSrc[E] = i; eDst[E] = j; eW[E] = Math.pow(rng(), 2); E++; indeg[j] += 1;
  }
}
// importance percentile from in-degree
const order = all.slice().sort((a, b) => indeg[a] - indeg[b]);
const impPct = new Float32Array(N); order.forEach((f, rank) => (impPct[f] = rank / Math.max(1, N - 1)));
const radius = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const rMin = 0.8, rMax = 12;
  const rSize = Math.min(rMax, Math.max(rMin, 0.8 * Math.cbrt(lines[i])));
  // file size sets the radius; importance enlarges it by up to half, on a curve that favours the top
  radius[i] = rSize * (1 + 0.5 * impPct[i] * impPct[i]);
}
// layout: sunflower in district, greedy spiral pack districts into cities, cities into world
function packCircles(r: number[], gap: number): [number, number][] {
  const idx = r.map((_, i) => i).sort((a, b) => r[b] - r[a]);
  const pos: [number, number][] = new Array(r.length); const placed: number[] = [];
  for (const i of idx) {
    if (!placed.length) { pos[i] = [0, 0]; placed.push(i); continue; }
    for (let s = 0; ; s++) {
      const th = s * 0.5, rho = s * (1 + gap / 10) * 0.35;
      const x = rho * Math.cos(th), z = rho * Math.sin(th);
      if (placed.every((j) => Math.hypot(x - pos[j][0], z - pos[j][1]) > r[i] + r[j] + gap)) { pos[i] = [x, z]; placed.push(i); break; }
    }
  }
  return pos;
}
const localX = new Float32Array(N), localZ = new Float32Array(N);
const distR: number[] = new Array(ND).fill(1);
for (let d = 0; d < ND; d++) {
  const m = distMembers[d].sort((a, b) => radius[b] - radius[a]);
  if (!m.length) continue;
  let s2 = 0; for (const f of m) s2 += radius[f] * radius[f];
  const c = 1.35 * Math.sqrt(s2 / m.length) * 1.15;
  m.forEach((f, k) => { const rho = c * Math.sqrt(k + 0.5), th = k * 2.39996323; localX[f] = rho * Math.cos(th); localZ[f] = rho * Math.sin(th); });
  distR[d] = c * Math.sqrt(m.length) + radius[m[0]];
}
const cityR: number[] = [], distOff: [number, number][] = new Array(ND);
for (let c = 0; c < NCITY; c++) {
  const ids = distOfCity[c]; const p = packCircles(ids.map((d) => distR[d]), 6);
  ids.forEach((d, k) => (distOff[d] = p[k]));
  cityR.push(Math.max(...ids.map((d, k) => Math.hypot(p[k][0], p[k][1]) + distR[d])));
}
const cityOff = packCircles(cityR, 40);
for (let i = 0; i < N; i++) { const o = distOff[fileDist[i]]; localX[i] += o[0]; localZ[i] += o[1]; }
let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
for (let c = 0; c < NCITY; c++) { minX = Math.min(minX, cityOff[c][0] - cityR[c]); maxX = Math.max(maxX, cityOff[c][0] + cityR[c]); minZ = Math.min(minZ, cityOff[c][1] - cityR[c]); maxZ = Math.max(maxZ, cityOff[c][1] + cityR[c]); }
const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, extent = Math.max(maxX - minX, maxZ - minZ);

// ---------- data textures ----------
const TEXW = 1024, TEXH = Math.ceil(N / TEXW);
const localData = new Float32Array(TEXW * TEXH * 4), colorData = new Float32Array(TEXW * TEXH * 4);
for (let i = 0; i < N; i++) {
  localData.set([localX[i], localZ[i], radius[i], fileCity[i]], i * 4);
  const L = LANG[fileLang[i]]; colorData.set([L[0], L[1], L[2], impPct[i]], i * 4);
}
const cityData = new Float32Array(16 * 4);
for (let c = 0; c < NCITY; c++) cityData.set([cityOff[c][0], cityOff[c][1], 0, 0], c * 4);
const mkTex = (d: Float32Array, w: number, h: number) => { const t = new THREE.DataTexture(d, w, h, THREE.RGBAFormat, THREE.FloatType); t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t; };
const texLocal = mkTex(localData, TEXW, TEXH), texColor = mkTex(colorData, TEXW, TEXH), texCity = mkTex(cityData, 16, 1);

// edge budget: strongest first
const eOrder = Array.from({ length: E }, (_, i) => i).sort((a, b) => eW[b] - eW[a]);
const EDRAW = Math.min(EDGE_BUDGET, E);
const genMs = performance.now() - t0;

// ---------- three setup ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 0);
document.body.appendChild(renderer.domElement);
document.body.style.background = DARK ? '#1C1C1C' : '#F6F8FC';
{ const h = document.getElementById('hud'); if (h && DARK) { h.style.background = 'rgba(28,28,28,.7)'; h.style.color = '#EDEFF2'; h.style.borderColor = '#444'; } }
const gl = renderer.getContext() as WebGL2RenderingContext;
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const GPU = dbg ? `${gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)} | ${gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)}` : String(gl.getParameter(gl.RENDERER));
const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, extent * 6);
const time = { value: 0 };
const common = { uLocal: { value: texLocal }, uColor: { value: texColor }, uCity: { value: texCity }, uTexW: { value: TEXW }, uTime: time };

const GLSL_COMMON = /* glsl */ `
uniform highp sampler2D uLocal; uniform highp sampler2D uColor; uniform highp sampler2D uCity; uniform int uTexW; uniform float uTime;
ivec2 tc(int i) { return ivec2(i % uTexW, i / uTexW); }
vec3 centerOf(int i, out float r) { vec4 L = texelFetch(uLocal, tc(i), 0); vec4 c = texelFetch(uCity, ivec2(int(L.w + 0.5), 0), 0); r = L.z; return vec3(c.x + L.x, L.z, c.y + L.y); }
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
`;

// ---- spheres: star look ----
// Each file is a small self-lit star. There is no light direction, no specular highlight and no
// shaded rim: brightness falls from a white-hot core through the file-type colour to a bright limb.
// Two draws over the same instances: bodies (depth write), then coronas (no depth write).
const quad = new THREE.InstancedBufferGeometry();
quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
quad.setIndex([0, 1, 2, 0, 2, 3]);
quad.instanceCount = N;
const uDark = { value: DARK ? 1 : 0 };
const STAR_VARY = /* glsl */ `varying vec2 vUv; varying vec3 vCol; varying float vGlow; varying float vSuper; varying float vScale; varying float vPhase; varying vec3 vCV; varying float vR;`;
const STAR_VERT = GLSL_COMMON + STAR_VARY + /* glsl */ `
  void main() {
    int i = gl_InstanceID; float r; vec3 c = centerOf(i, r);
    vec4 C = texelFetch(uColor, tc(i), 0);
    vGlow = smoothstep(0.90, 1.0, C.w);       // importance glow: about the top 10% of files
    vSuper = smoothstep(0.975, 1.0, C.w);     // the top few percent flare like a supernova
    #ifdef CORONA
      vScale = 1.35 + 1.7 * vGlow + 2.4 * vSuper;
    #else
      vScale = 1.0;
    #endif
    vUv = position.xy * vScale; vCol = C.rgb; vPhase = hash11(float(i)) * 6.2831; vR = r;
    vec4 mv = viewMatrix * vec4(c, 1.0); vCV = mv.xyz;
    mv.xy += position.xy * r * vScale;
    #ifdef CORONA
      mv.z += r * 0.02; // sit just in front of its own disc; nearer stars still occlude it
    #endif
    gl_Position = projectionMatrix * mv;
  }`;
const GLSL_NOISE = /* glsl */ `
  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }`;
const sphereMat = new THREE.ShaderMaterial({
  uniforms: { ...common, uDark },
  defines: FRAGDEPTH ? { FRAGDEPTH: 1 } : {},
  vertexShader: STAR_VERT,
  fragmentShader: /* glsl */ `
    uniform mat4 projectionMatrix; uniform float uTime; uniform float uDark; ` + STAR_VARY + GLSL_NOISE + /* glsl */ `
    void main() {
      float d2 = dot(vUv, vUv); if (d2 > 1.0) discard;
      float d = sqrt(d2);
      float px = 1.0 / max(fwidth(d), 1e-4);                 // radius in pixels
      float detail = smoothstep(5.0, 16.0, px);              // surface detail only when large on screen
      float ang = atan(vUv.y, vUv.x); float t = uTime;
      float flick = 1.0 + 0.07 * (sin(t * 1.1 + vPhase) * 0.65 + sin(t * 2.7 + vPhase * 1.9) * 0.35);

      // plasma: slow turbulent brightness across the surface
      float n = 0.5;
      if (detail > 0.0) { vec2 q = vUv * 2.6 + vec2(vPhase, vPhase * 1.7);
        n = vnoise(q + t * 0.12) * 0.6 + vnoise(q * 2.3 - t * 0.19) * 0.4; }

      // The disc is opaque and cut slightly inside its nominal radius; the corona pass blooms over the
      // cut, so there is never a crisp silhouette (a crisp edge is what makes a ball read as a marble).
      if (d > 0.93) discard;

      // Emission, then exposure. Brightness is highest at the centre and falls smoothly to the limb.
      // Passing it through an exposure curve lets the centre burn out toward white the way a bright
      // light source does on a sensor. Nothing is drawn: no core shape, no rays, no highlight.
      vec3 hue = vCol / max(max(vCol.r, vCol.g), max(vCol.b, 1e-3));
      hue = pow(hue, vec3(1.6));                               // keep the file-type colour saturated
      float limbDark = mix(1.0, 0.62, d2);
      float core = exp(-d2 * mix(13.0, 8.0, vGlow)) * mix(2.4, 5.0, vGlow) * flick;
      float I = (1.30 + core) * limbDark * (1.0 + detail * 0.28 * (n - 0.5));
      vec3 col = 1.0 - exp(-hue * I);
      vec3 hot = uDark > 0.5 ? vec3(1.0, 0.97, 0.90) : vec3(1.0, 0.95, 0.82);
      col = mix(col, hot, 1.0 - exp(-core * 0.30));
      gl_FragColor = vec4(col, 1.0);
    }`,
  transparent: false, depthWrite: true, depthTest: true,
});
const spheres = new THREE.Mesh(quad, sphereMat); spheres.frustumCulled = false; spheres.renderOrder = 1; scene.add(spheres);

const coronaMat = new THREE.ShaderMaterial({
  uniforms: sphereMat.uniforms,
  defines: { CORONA: 1 },
  vertexShader: STAR_VERT,
  fragmentShader: /* glsl */ `
    uniform float uTime; uniform float uDark; ` + STAR_VARY + /* glsl */ `
    void main() {
      float d = length(vUv);
      if (d < 0.915 || d > vScale) discard;
      float t = uTime;
      // Glow: starts at the disc's cut edge at about the limb's own brightness, so the edge has no
      // outline, then falls away in a long soft tail. Smooth everywhere: no drawn rays, no rings.
      float s = mix(8.0, 2.2, vGlow);
      float g = 1.0 / (1.0 + pow(max(d - 0.93, 0.0) * s, 2.0));
      float a = g * (0.50 + 0.25 * vGlow) * (1.0 + 0.05 * sin(t * 0.9 + vPhase));
      if (vSuper > 0.0) {
        // thin, faint diffraction spikes on the very brightest only, as a telescope would show them
        float cs = cos(0.35), sn = sin(0.35); vec2 u = vec2(cs * vUv.x - sn * vUv.y, sn * vUv.x + cs * vUv.y);
        float sx = exp(-abs(u.y) * 26.0) / (1.0 + u.x * u.x * 0.9);
        float sy = exp(-abs(u.x) * 26.0) / (1.0 + u.y * u.y * 0.9);
        a += (sx + sy) * 0.45 * vSuper;
      }
      a *= 1.0 - smoothstep(vScale * 0.75, vScale, d);
      if (a < 0.004) discard;
      vec3 col = vCol;
      gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * (uDark > 0.5 ? 1.0 : 0.6));
    }`,
  transparent: true, depthWrite: false, depthTest: true,
  blending: DARK ? THREE.AdditiveBlending : THREE.NormalBlending,
});
if (CORONA) { const corona = new THREE.Mesh(quad, coronaMat); corona.frustumCulled = false; corona.renderOrder = 1.5; scene.add(corona); }

// ---- edges ----
const edgeGeo = new THREE.InstancedBufferGeometry();
{
  const pos: number[] = [], idx: number[] = [];
  for (let s = 0; s <= SEG; s++) { pos.push(s / SEG, -1, 0, s / SEG, 1, 0); if (s < SEG) { const b = s * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); } }
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3)); edgeGeo.setIndex(idx);
  const aS = new Float32Array(EDRAW), aD = new Float32Array(EDRAW), aW = new Float32Array(EDRAW), aP = new Float32Array(EDRAW);
  for (let k = 0; k < EDRAW; k++) { const e = eOrder[k]; aS[k] = eSrc[e]; aD[k] = eDst[e]; aW[k] = eW[e]; aP[k] = rng(); }
  edgeGeo.setAttribute('aSrc', new THREE.InstancedBufferAttribute(aS, 1));
  edgeGeo.setAttribute('aDst', new THREE.InstancedBufferAttribute(aD, 1));
  edgeGeo.setAttribute('aW', new THREE.InstancedBufferAttribute(aW, 1));
  edgeGeo.setAttribute('aPh', new THREE.InstancedBufferAttribute(aP, 1));
  edgeGeo.instanceCount = EDRAW;
}
const pixelWorld = { value: 0 };
const edgeMat = new THREE.ShaderMaterial({
  uniforms: { ...common, uPix: pixelWorld, uDark: { value: DARK ? 1 : 0 } },
  vertexShader: GLSL_COMMON + /* glsl */ `
    uniform float uPix; attribute float aSrc; attribute float aDst; attribute float aW; attribute float aPh;
    varying float vT; varying float vSide; varying float vLen; varying float vW; varying float vPh; varying vec3 vCa; varying vec3 vCb;
    void main() {
      float ra, rb; vec3 a = centerOf(int(aSrc), ra); vec3 b = centerOf(int(aDst), rb);
      float t = position.x; float len = distance(a.xz, b.xz) + 1.0;
      float lift = 0.22 * len + 2.0;
      vec3 p = mix(a, b, t); p.y += sin(3.14159265 * t) * lift;
      vec3 tg = (b - a) + vec3(0.0, 3.14159265 * cos(3.14159265 * t) * lift, 0.0);
      vec3 toCam = cameraPosition - p;
      vec3 side = normalize(cross(tg, toCam));
      // The strip is three times the line's width: the fragment shader draws a thin trace down the
      // middle and uses the extra room for the glow around a passing pulse.
      float px = uPix * length(toCam); float w = clamp(0.15 + 0.5 * aW, px * 0.9, px * 3.0) * 3.0;
      p += side * position.y * w;
      vT = t; vSide = position.y; vLen = len; vW = aW; vPh = aPh;
      vCa = texelFetch(uColor, tc(int(aSrc)), 0).rgb; vCb = texelFetch(uColor, tc(int(aDst)), 0).rgb;
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform float uTime; uniform float uDark; varying float vT; varying float vSide; varying float vLen; varying float vW; varying float vPh; varying vec3 vCa; varying vec3 vCb;
    void main() {
      vec3 col = mix(vCa, vCb, vT);
      float s2 = vSide * vSide;
      float line = exp(-s2 * 22.0);                 // the thin, always-visible trace
      float glow = exp(-s2 * 3.5);                  // the wider light around a pulse
      float w01 = clamp(vW, 0.0, 1.0);
      float trace = (0.16 + 0.20 * w01) * line;

      // An electrical pulse: it fires, crosses the connection at a fixed world speed, then the line
      // rests. Heavier connections rest for less time, so they fire more often.
      float travel = vLen / 120.0;
      float rest = mix(2.4, 0.5, w01) * (0.6 + 0.8 * fract(sin(vPh * 91.7) * 43758.5));
      float period = travel + rest;
      float head = fract(uTime / period + vPh) * period / travel;   // 0..1 while crossing, above 1 at rest
      float x = head - vT;                                          // how far this point is behind the head
      float tailLen = clamp(30.0 / vLen, 0.04, 0.40);               // about 30 world units of tail
      float tail = (x > 0.0 && x < tailLen) ? pow(1.0 - x / tailLen, 3.0) : 0.0;
      float bead = exp(-pow(x / (tailLen * 0.10), 2.0)) * step(head, 1.0 + tailLen);  // the bright head
      float crackle = 0.72 + 0.28 * sin(uTime * 60.0 + vPh * 300.0 + vT * 45.0);      // fast flicker
      float p = (tail * 0.9 + bead * 1.4) * crackle * (0.65 + 0.55 * w01);

      if (uDark > 0.5) {
        // emitted light: white-hot at the head, cooling to the connection's colour along the tail
        vec3 pc = mix(col * 1.35, vec3(1.0, 0.98, 0.92), clamp(bead + tail * tail * 0.5, 0.0, 1.0));
        gl_FragColor = vec4(col * trace + pc * p * (glow * 0.85 + line * 0.6), 1.0);
      } else {
        float a = clamp(trace + p * (glow * 0.7 + line * 0.5), 0.0, 1.0);
        gl_FragColor = vec4(mix(col * 0.85, col * 0.6, clamp(p, 0.0, 1.0)), a);
      }
    }`,
  transparent: true, depthWrite: false, depthTest: true,
  blending: DARK ? THREE.AdditiveBlending : THREE.NormalBlending,
});
const edges = new THREE.Mesh(edgeGeo, edgeMat); edges.frustumCulled = false; edges.renderOrder = 2; scene.add(edges);

// ---- particles ----
let particles: THREE.Points | null = null;
const projScale = { value: 0 };
if (PARTICLES > 0) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PARTICLES * 3), 3));
  const host = new Float32Array(PARTICLES), seed = new Float32Array(PARTICLES);
  const wHost = new Float32Array(N); for (let i = 0; i < N; i++) wHost[i] = impPct[i] > 0.5 ? Math.pow(impPct[i], 6) : 0;
  const hc = cdfOf(wHost);
  for (let p = 0; p < PARTICLES; p++) { host[p] = rng() < 0.8 ? cdfPick(hc) : -1; seed[p] = rng(); }
  g.setAttribute('aHost', new THREE.BufferAttribute(host, 1)); g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { ...common, uProj: projScale, uBounds: { value: new THREE.Vector4(minX, minZ, maxX - minX, maxZ - minZ) } },
    vertexShader: GLSL_COMMON + /* glsl */ `
      uniform float uProj; uniform vec4 uBounds; attribute float aHost; attribute float aSeed;
      varying float vA; varying vec3 vCol;
      void main() {
        vec3 p; float size;
        if (aHost >= 0.0) {
          float r; vec3 c = centerOf(int(aHost), r);
          float life = fract(uTime * (0.12 + 0.1 * aSeed) + aSeed * 17.0);
          float th = hash11(aSeed * 911.0) * 6.2831, ph = hash11(aSeed * 373.0) * 1.3;
          vec3 dir = vec3(cos(th) * cos(ph), sin(ph), sin(th) * cos(ph));
          p = c + dir * r * (1.0 + 2.5 * life) + vec3(0.0, life * 2.5 * r, 0.0);
          size = 0.12 * r + 0.3; vA = sin(3.14159 * life) * 0.8; vCol = texelFetch(uColor, tc(int(aHost)), 0).rgb * 0.85;
        } else {
          vec3 h = vec3(hash11(aSeed * 101.0), hash11(aSeed * 557.0), hash11(aSeed * 997.0));
          p = vec3(uBounds.x + h.x * uBounds.z, 10.0 + h.y * 0.25 * uBounds.z, uBounds.y + h.z * uBounds.w);
          p += vec3(sin(uTime * 0.05 + aSeed * 40.0), sin(uTime * 0.07 + aSeed * 13.0), cos(uTime * 0.04 + aSeed * 29.0)) * 15.0;
          size = 0.8; vA = 0.25; vCol = vec3(0.45, 0.5, 0.6);
        }
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp(size * uProj / -mv.z, 1.0, 12.0);
        vA *= clamp(1.0 - (-mv.z) / (uBounds.z * 2.5), 0.2, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA; varying vec3 vCol;
      void main() { vec2 q = gl_PointCoord * 2.0 - 1.0; float d = dot(q, q); if (d > 1.0) discard; gl_FragColor = vec4(vCol, vA * (1.0 - d)); }`,
    transparent: true, depthWrite: false, blending: DARK ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  particles = new THREE.Points(g, m); particles.frustumCulled = false; particles.renderOrder = 3; scene.add(particles);
}

// ---- territory footprint pass ----
const TERR_RES = 512;
const terrRT = new THREE.WebGLRenderTarget(TERR_RES, TERR_RES, { type: THREE.HalfFloatType, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
const terrScene = new THREE.Scene();
const pad = extent * 0.08;
const terrBounds = new THREE.Vector4(cx - extent / 2 - pad, cz - extent / 2 - pad, extent + 2 * pad, extent + 2 * pad);
const terrCam = new THREE.OrthographicCamera(terrBounds.x, terrBounds.x + terrBounds.z, -terrBounds.y, -(terrBounds.y + terrBounds.w), -10, 10);
// camera looks down -Y: build an explicit view (x→x, z→ -y screen)
terrCam.position.set(0, 5, 0); terrCam.up.set(0, 0, -1); terrCam.lookAt(0, 0, 0);
const cityTint = new Float32Array(16 * 4); CITY_TINT.forEach((c, i) => cityTint.set([c.r, c.g, c.b, 1], i * 4));
const texCityTint = mkTex(cityTint, 16, 1);
if (TERR) {
  const fq = quad.clone(); fq.instanceCount = N;
  const fm = new THREE.ShaderMaterial({
    uniforms: { ...common, uTint: { value: texCityTint } },
    vertexShader: GLSL_COMMON + /* glsl */ `
      uniform highp sampler2D uTint; varying vec2 vQ; varying vec3 vTint;
      void main() {
        int i = gl_InstanceID; float r; vec3 c = centerOf(i, r);
        vec4 L = texelFetch(uLocal, tc(i), 0);
        vTint = texelFetch(uTint, ivec2(int(L.w + 0.5), 0), 0).rgb; vQ = position.xy;
        vec3 p = vec3(c.x + position.x * r * 3.0, 0.0, c.z + position.y * r * 3.0);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vQ; varying vec3 vTint;
      void main() { float d = dot(vQ, vQ); if (d > 1.0) discard; float w = exp(-d * 4.0); float sh = exp(-d * 30.0); gl_FragColor = vec4(vTint * w, w + sh * 4.0 * 0.0) + vec4(0.0, 0.0, 0.0, 0.0); }`,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    depthTest: false, depthWrite: false, transparent: true,
  });
  const fp = new THREE.Mesh(fq, fm); fp.frustumCulled = false; terrScene.add(fp);
}

// ---- background: dust wisps ----
const bgGeo = new THREE.BufferGeometry();
bgGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const bgMat = new THREE.ShaderMaterial({
  uniforms: { uTime: time, uDark, uRes: { value: new THREE.Vector2(1, 1) }, uPar: { value: new THREE.Vector2() } },
  vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uTime; uniform float uDark; uniform vec2 uRes; uniform vec2 uPar;` + GLSL_NOISE + /* glsl */ `
    float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
    void main() {
      vec2 uv = gl_FragCoord.xy / uRes.y;
      vec2 p = uv * 1.6 + uPar + vec2(uTime * 0.004, 0.0);
      vec2 w = vec2(fbm(p + 3.1), fbm(p + vec2(7.7, 1.3)));
      float cool = smoothstep(0.35, 0.80, fbm(p + 1.8 * w));
      float warm = smoothstep(0.50, 0.85, fbm(p * 0.7 + 2.2 * w.yx + 11.0));
      vec3 voidC = uDark > 0.5 ? vec3(0.110) : vec3(0.965, 0.973, 0.988);
      vec3 coolC = uDark > 0.5 ? vec3(0.294, 0.318, 0.345) : vec3(0.827, 0.855, 0.890);
      vec3 warmC = uDark > 0.5 ? vec3(0.420, 0.353, 0.298) : vec3(0.953, 0.863, 0.776);
      vec3 col = mix(voidC, coolC, cool * 0.38);
      col = mix(col, warmC, warm * 0.22);
      if (uDark > 0.5) { vec2 g = floor(gl_FragCoord.xy / 3.0); col += vec3(0.75) * step(0.9985, h21(g)) * (0.4 + 0.6 * h21(g + 5.0)); }
      vec2 c = gl_FragCoord.xy / uRes - 0.5;
      col *= 1.0 - dot(c, c) * (uDark > 0.5 ? 0.40 : 0.12);
      gl_FragColor = vec4(col, 1.0);
    }`,
  depthTest: false, depthWrite: false,
});
if (WISPS) { const bg = new THREE.Mesh(bgGeo, bgMat); bg.frustumCulled = false; bg.renderOrder = -10; scene.add(bg); }

// ---- ground light: each star lights the plane beneath it ----
if (POOLS) {
  const pq = quad.clone(); pq.instanceCount = N;
  const pm = new THREE.ShaderMaterial({
    uniforms: { ...common, uDark },
    vertexShader: GLSL_COMMON + /* glsl */ `
      varying vec2 vQ; varying vec3 vCol; varying float vGlow;
      void main() {
        int i = gl_InstanceID; float r; vec3 c = centerOf(i, r);
        vec4 C = texelFetch(uColor, tc(i), 0);
        vGlow = smoothstep(0.90, 1.0, C.w); float sup = smoothstep(0.975, 1.0, C.w);
        float R = r * (2.0 + 3.0 * vGlow + 3.0 * sup);
        vQ = position.xy; vCol = C.rgb;
        gl_Position = projectionMatrix * viewMatrix * vec4(c.x + position.x * R, 0.05, c.z + position.y * R, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uDark; varying vec2 vQ; varying vec3 vCol; varying float vGlow;
      void main() {
        float d2 = dot(vQ, vQ); if (d2 > 1.0) discard;
        float w = exp(-d2 * 4.0) * (1.0 - d2);
        if (uDark > 0.5) gl_FragColor = vec4(vCol, w * (0.16 + 0.55 * vGlow));
        else gl_FragColor = vec4(mix(vec3(0.25, 0.27, 0.32), vCol, 0.35 + 0.65 * vGlow), w * (0.22 + 0.35 * vGlow));
      }`,
    transparent: true, depthWrite: false, depthTest: true,
    blending: DARK ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const pools = new THREE.Mesh(pq, pm); pools.frustumCulled = false; pools.renderOrder = 0; scene.add(pools);
}

// ---- ground ----
const groundMat = new THREE.ShaderMaterial({
  uniforms: { uTerr: { value: terrRT.texture }, uTB: { value: terrBounds }, uUseTerr: { value: TERR ? 1 : 0 }, uCenter: { value: new THREE.Vector2(cx, cz) }, uExt: { value: extent }, uDark },
  vertexShader: /* glsl */ `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uTerr; uniform vec4 uTB; uniform int uUseTerr; uniform vec2 uCenter; uniform float uExt; uniform float uDark; varying vec3 vW;
    float grid(vec2 p, float s) { vec2 g = abs(fract(p / s - 0.5) - 0.5) / fwidth(p / s); return 1.0 - min(min(g.x, g.y), 1.0); }
    void main() {
      float distC = length(vW.xz - uCenter) / uExt;
      float fade = 1.0 - smoothstep(0.55, 1.1, distC);
      float camFade = 1.0 - smoothstep(0.0, uExt * 1.8, distance(cameraPosition, vW));
      float g = grid(vW.xz, 20.0) * 0.5 + grid(vW.xz, 100.0) * 0.5;
      float fill = 0.0, line = 0.0; vec3 tint = vec3(1.0);
      if (uUseTerr == 1) {
        vec2 uv = (vW.xz - uTB.xy) / uTB.zw; uv.y = 1.0 - uv.y;
        vec4 t = texture2D(uTerr, uv);
        float dens = t.a; tint = t.rgb / max(dens, 1e-4);
        fill = smoothstep(0.05, 0.6, dens);
        line = 1.0 - smoothstep(0.0, fwidth(dens) * 1.5, abs(dens - 0.12));
      }
      if (uDark > 0.5) {
        // territories are pools of light with luminous contours; the grid is faint starlight
        vec3 add = vec3(0.80, 0.84, 0.90) * g * 0.040 * camFade;
        add += tint * fill * 0.060 + tint * line * 0.28;
        gl_FragColor = vec4(add * fade, 1.0);
      } else {
        // tinted fills and contour lines over the pale void; the grid is faint ink
        float a1 = 0.06 * g * camFade, a2 = fill * 0.20, a3 = line * 0.5;
        vec3 c = vec3(0.12, 0.13, 0.15) * a1; float al = a1;
        c = c * (1.0 - a2) + tint * a2; al = al * (1.0 - a2) + a2;
        c = c * (1.0 - a3) + tint * 0.75 * a3; al = al * (1.0 - a3) + a3;
        gl_FragColor = vec4(c / max(al, 1e-4), al * fade);
      }
    }`,
  transparent: true, depthWrite: false,
  blending: DARK ? THREE.AdditiveBlending : THREE.NormalBlending,
});
const ground = new THREE.Mesh(new THREE.PlaneGeometry(extent * 3, extent * 3).rotateX(-Math.PI / 2), groundMat);
ground.position.set(cx, 0, cz); ground.renderOrder = -1; scene.add(ground);

// ---------- loop + measurement ----------
const hud = document.getElementById('hud')!;
const info = { N, E, EDRAW, PARTICLES, TERR, TERR_HOT, FRAGDEPTH, SEG, DPR, genMs: Math.round(genMs), extent: Math.round(extent), GPU, timerQuery: !!timerExt, canvas: '' };
console.log('[render-spike] scene', info);
let terrDirty = true;
let bench: { works: number[]; gpus: number[] } | null = null;
const pendingQ: WebGLQuery[] = [];
let frameCount = 0, lastHud = performance.now(), hudFrames = 0, lastT = performance.now();
const recent: number[] = [];

function placeCamera(t: number) {
  const th = ORBIT ? t * 0.25 : ANGLE;
  const d = extent * 0.85 * DIST;
  const lx = cx + LOOKX * extent, lz = cz + LOOKZ * extent;
  camera.position.set(lx + Math.cos(th) * d, d * CAMH, lz + Math.sin(th) * d);
  camera.lookAt(lx, 0, lz);
  bgMat.uniforms.uPar.value.set(th * 0.05, camera.position.y / extent * 0.05);
}
function resize() {
  renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  const h = innerHeight * DPR;
  pixelWorld.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / h;
  projScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  info.canvas = `${renderer.domElement.width}x${renderer.domElement.height}`;
  bgMat.uniforms.uRes.value.set(renderer.domElement.width, renderer.domElement.height);
}
addEventListener('resize', resize); resize();

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = now - lastT; lastT = now; recent.push(dt); if (recent.length > 120) recent.shift();
  time.value = now / 1000;
  placeCamera(now / 1000);
  const w0 = performance.now();
  let q: WebGLQuery | null = null;
  if (timerExt && bench) { q = gl.createQuery()!; gl.beginQuery(timerExt.TIME_ELAPSED_EXT, q); }
  if (TERR && (terrDirty || TERR_HOT)) { renderer.setRenderTarget(terrRT); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(terrScene, terrCam); renderer.setRenderTarget(null); terrDirty = false; }
  renderer.render(scene, camera);
  if (q && timerExt) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); pendingQ.push(q); }
  if (FINISH) gl.finish();
  const work = performance.now() - w0;
  if (bench) bench.works.push(work);
  while (pendingQ.length && gl.getQueryParameter(pendingQ[0], gl.QUERY_RESULT_AVAILABLE)) {
    const qq = pendingQ.shift()!; const disjoint = gl.getParameter(timerExt!.GPU_DISJOINT_EXT);
    if (!disjoint && bench) bench.gpus.push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(qq);
  }
  frameCount++; hudFrames++;
  if (now - lastHud > 500) {
    const s = recent.slice().sort((a, b) => a - b);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    hud.textContent = `N=${N} edges=${EDRAW}/${E} particles=${PARTICLES} terr=${TERR ? (TERR_HOT ? 'hot' : 'once') : 'off'} fd=${FRAGDEPTH ? 1 : 0}\n` +
      `fps ${(1000 / avg).toFixed(1)}  avg ${avg.toFixed(2)} ms  p95 ${s[Math.floor(s.length * 0.95)]?.toFixed(2)} ms  cpu-submit ${work.toFixed(2)} ms\n${GPU}\ncanvas ${info.canvas} dpr ${DPR}`;
    lastHud = now; hudFrames = 0;
  }
}
requestAnimationFrame(frame);

const stats = (a: number[]) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const avg = a.reduce((x, y) => x + y, 0) / a.length; const p = (f: number) => +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(2); return { avg: +avg.toFixed(2), p50: p(0.5), p95: p(0.95), p99: p(0.99), max: +s[s.length - 1].toFixed(2), n: a.length }; };
(window as any).__info = info;
(window as any).__bench = (sec = 5) => new Promise((res) => {
  const dts: number[] = []; bench = { works: [], gpus: [] }; let last = -1; const start = performance.now();
  const f = (now: number) => { if (last >= 0) dts.push(now - last); last = now; if (now - start < sec * 1000) requestAnimationFrame(f); else { const b = bench!; bench = null; const r = { info, frame: stats(dts), fps: +(1000 / (dts.reduce((x, y) => x + y, 0) / dts.length)).toFixed(1), cpuSubmit: stats(b.works), gpu: stats(b.gpus), hidden: document.hidden }; (window as any).__last = r; console.log('[render-spike] bench', JSON.stringify(r)); res(r); } };
  requestAnimationFrame(f);
});
// Synchronous benchmark: independent of rAF (which is throttled when the pane is hidden).
// Renders `frames` frames back to back at a fixed canvas size, advancing time + orbit 1/60 s per frame,
// timing each render()+gl.finish() on the CPU (and GPU timer queries if the extension exists).
(window as any).__benchSync = async (frames = 300, w = 1920, h = 1080, dpr = 1) => {
  renderer.setPixelRatio(dpr); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  pixelWorld.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / (h * dpr);
  projScale.value = (h * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  const ms: number[] = []; const qs: WebGLQuery[] = []; const gpu: number[] = [];
  const tStart = time.value;
  for (let f = -10; f < frames; f++) { // 10 warm-up frames
    const t = tStart + Math.max(f, 0) / 60; time.value = t; placeCamera(t);
    const a = performance.now();
    let q: WebGLQuery | null = null;
    if (timerExt && f >= 0) { q = gl.createQuery()!; gl.beginQuery(timerExt.TIME_ELAPSED_EXT, q); }
    if (TERR && TERR_HOT) { renderer.setRenderTarget(terrRT); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(terrScene, terrCam); renderer.setRenderTarget(null); }
    renderer.render(scene, camera);
    if (q) { gl.endQuery(timerExt!.TIME_ELAPSED_EXT); qs.push(q); }
    gl.finish();
    // readPixels of 1 px forces a full sync on ANGLE/D3D11 where finish() may return early
    const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    if (f >= 0) ms.push(performance.now() - a);
  }
  await new Promise((r) => setTimeout(r, 300));
  for (const q of qs) { if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q); }
  const r = { info: { ...info, canvas: `${w * dpr}x${h * dpr}` }, frames, frameMs: stats(ms), fpsEquiv: +(1000 / (ms.reduce((x, y) => x + y, 0) / ms.length)).toFixed(1), gpu: stats(gpu), hidden: document.hidden };
  renderer.setPixelRatio(DPR); resize();
  (window as any).__last = r; console.log('[render-spike] benchSync', JSON.stringify(r)); return r;
};
(window as any).__snap = async (name = 'screenshot.png', t = 4) => { time.value = t; placeCamera(t); if (TERR) { renderer.setRenderTarget(terrRT); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(terrScene, terrCam); renderer.setRenderTarget(null); } renderer.render(scene, camera); const src = renderer.domElement; const c2 = document.createElement('canvas'); c2.width = src.width; c2.height = src.height; const x = c2.getContext('2d')!; x.fillStyle = DARK ? '#1C1C1C' : '#F6F8FC'; x.fillRect(0, 0, c2.width, c2.height); x.drawImage(src, 0, 0); const url = c2.toDataURL('image/png'); const r = await fetch('/__save?name=' + encodeURIComponent(name), { method: 'POST', body: url }); return r.text(); };
