// Synthetic clustered graph generator (seeded, deterministic).
// 12 cities x 8 districts, files assigned to districts with skewed sizes,
// edges mostly intra-district, some intra-city, few inter-city.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Graph {
  nCities: number;
  nDistricts: number;
  nFiles: number;
  districtCity: Int32Array; // district -> city
  cityDistricts: number[][]; // city -> global district ids
  fileDistrict: Int32Array; // file -> district
  districtFiles: number[][]; // district -> global file ids
  fileR: Float32Array; // sphere radius
  // intra-district edges, as global file ids
  fileEdges: [number, number][][]; // per district
  // intra-city district edges with weights, per city (global district ids)
  districtEdges: { s: number; t: number; w: number }[][];
  cityEdges: { s: number; t: number; w: number }[];
  // per district: weight toward each other city
  districtExternal: Map<number, number>[];
}

export interface GenOpts {
  files: number;
  cities?: number;
  districtsPerCity?: number;
  seed?: number;
  edgesPerFile?: number;
}

export function fileRadiusFromU(u: number): number {
  // radiusMin 0.6 .. radiusMax 12, most files small
  return 0.6 + 11.4 * u * u * u;
}

export function generate(o: GenOpts): Graph {
  const rnd = mulberry32(o.seed ?? 1);
  const nCities = o.cities ?? 12;
  const dpc = o.districtsPerCity ?? 8;
  const nDistricts = nCities * dpc;
  const nFiles = o.files;
  const epf = o.edgesPerFile ?? 3;

  const districtCity = new Int32Array(nDistricts);
  const cityDistricts: number[][] = [];
  for (let c = 0; c < nCities; c++) {
    cityDistricts.push([]);
    for (let k = 0; k < dpc; k++) {
      const d = c * dpc + k;
      districtCity[d] = c;
      cityDistricts[c].push(d);
    }
  }

  // skewed district weights (log-normal-ish)
  const dw = new Float64Array(nDistricts);
  let sum = 0;
  for (let d = 0; d < nDistricts; d++) {
    const g = (rnd() + rnd() + rnd() - 1.5) * 2; // ~N(0,1)
    dw[d] = Math.exp(0.8 * g);
    sum += dw[d];
  }
  const cdf = new Float64Array(nDistricts);
  let acc = 0;
  for (let d = 0; d < nDistricts; d++) {
    acc += dw[d] / sum;
    cdf[d] = acc;
  }

  const fileDistrict = new Int32Array(nFiles);
  const districtFiles: number[][] = Array.from({ length: nDistricts }, () => []);
  const fileR = new Float32Array(nFiles);
  for (let f = 0; f < nFiles; f++) {
    // guarantee every district gets at least one file
    let d: number;
    if (f < nDistricts) d = f;
    else {
      const u = rnd();
      let lo = 0, hi = nDistricts - 1;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (cdf[m] < u) lo = m + 1;
        else hi = m;
      }
      d = lo;
    }
    fileDistrict[f] = d;
    districtFiles[d].push(f);
    fileR[f] = fileRadiusFromU(rnd());
  }

  const fileEdges: [number, number][][] = Array.from({ length: nDistricts }, () => []);
  const dEdgeMap: Map<string, number>[] = Array.from({ length: nCities }, () => new Map());
  const cEdgeMap = new Map<string, number>();
  const districtExternal: Map<number, number>[] = Array.from({ length: nDistricts }, () => new Map());

  for (let f = 0; f < nFiles; f++) {
    const d = fileDistrict[f];
    const c = districtCity[d];
    for (let e = 0; e < epf; e++) {
      const u = rnd();
      if (u < 0.8) {
        const fs = districtFiles[d];
        if (fs.length < 2) continue;
        // preferential: low local index more popular
        const t = fs[Math.floor(fs.length * rnd() * rnd())];
        if (t !== f) fileEdges[d].push([f, t]);
      } else if (u < 0.95) {
        const ds = cityDistricts[c];
        const d2 = ds[Math.floor(rnd() * ds.length)];
        if (d2 === d) continue;
        const key = d < d2 ? `${d}-${d2}` : `${d2}-${d}`;
        dEdgeMap[c].set(key, (dEdgeMap[c].get(key) ?? 0) + 1);
      } else {
        // inter-city, biased toward "neighbour" cities
        let c2 = (c + 1 + Math.floor(rnd() * rnd() * (nCities - 1))) % nCities;
        if (c2 === c) continue;
        const key = c < c2 ? `${c}-${c2}` : `${c2}-${c}`;
        cEdgeMap.set(key, (cEdgeMap.get(key) ?? 0) + 1);
        const m = districtExternal[d];
        m.set(c2, (m.get(c2) ?? 0) + 1);
      }
    }
  }

  const districtEdges = dEdgeMap.map((m) =>
    [...m].map(([k, w]) => {
      const [s, t] = k.split("-").map(Number);
      return { s, t, w };
    }),
  );
  const cityEdges = [...cEdgeMap].map(([k, w]) => {
    const [s, t] = k.split("-").map(Number);
    return { s, t, w };
  });

  return {
    nCities, nDistricts, nFiles, districtCity, cityDistricts, fileDistrict,
    districtFiles, fileR, fileEdges, districtEdges, cityEdges, districtExternal,
  };
}
