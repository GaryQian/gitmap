// Main thread: reads SAB positions each rAF under a seqlock and draws dots. Driven via window.spike.
const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const out = document.getElementById("out")!;
const log = (s: string) => { out.textContent += s + "\n"; console.log(s); };

let worker: Worker;
let R: any; // ready message
let city!: Float32Array, district!: Float32Array, file!: Float32Array; // local copies
let fileDistrict!: Int32Array;
let lastSeq = [-1, -1, -1];
let bounds = { x0: -1, y0: -1, s: 1 };
const frame = { frames: 0, cityChanged: 0, fileChanged: 0, districtChanged: 0, tornRetries: 0, readMs: 0, drawMs: 0 };
const waiters: ((m: any) => void)[] = [];
const COLORS = Array.from({ length: 32 }, (_, k) => [(k * 97) % 200 + 30, (k * 57) % 200 + 30, (k * 151) % 200 + 30]);

function readTier(k: number, src: Float32Array, dst: Float32Array): boolean {
  const s1 = Atomics.load(R.seq, k);
  if (s1 === lastSeq[k]) return false;
  if (s1 & 1) { frame.tornRetries++; return false; } // writer mid-update; try next frame
  dst.set(src);
  const s2 = Atomics.load(R.seq, k);
  if (s1 !== s2) { frame.tornRetries++; return false; }
  lastSeq[k] = s1;
  return true;
}

function draw() {
  const W = canvas.width, H = canvas.height;
  const img = ctx.createImageData(W, H);
  const px = img.data;
  const n = fileDistrict.length;
  for (let i = 0; i < n; i++) {
    const d = fileDistrict[i];
    if (d < 0) continue;
    const c = R.districtCity[d];
    const x = city[3 * c] + district[3 * d] + file[2 * i];
    const y = city[3 * c + 1] + district[3 * d + 1] + file[2 * i + 1];
    const sx = ((x - bounds.x0) * bounds.s) | 0, sy = ((y - bounds.y0) * bounds.s) | 0;
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
    const o = (sy * W + sx) * 4, col = COLORS[c % 32];
    px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = "#0003";
  for (let c = 0; c < R.K; c++) {
    ctx.beginPath();
    ctx.arc((city[3 * c] - bounds.x0) * bounds.s, (city[3 * c + 1] - bounds.y0) * bounds.s, city[3 * c + 2] * bounds.s, 0, 7);
    ctx.stroke();
  }
}

function raf() {
  const t0 = performance.now();
  const a = readTier(0, R.cityBuf, city), b = readTier(1, R.districtBuf, district), c = readTier(2, R.fileBuf, file);
  const t1 = performance.now();
  frame.frames++;
  if (a) frame.cityChanged++;
  if (b) frame.districtChanged++;
  if (c) frame.fileChanged++;
  frame.readMs += t1 - t0;
  if (a || b || c) { draw(); frame.drawMs += performance.now() - t1; }
  requestAnimationFrame(raf);
}

function nextMsg(type: string): Promise<any> {
  return new Promise((res) => waiters.push((m) => { if (m.type === type) { res(m); return true; } return false; }) as any);
}
function onMsg(ev: MessageEvent) {
  const m = ev.data;
  for (let k = 0; k < waiters.length; k++) if ((waiters[k] as any)(m)) { waiters.splice(k, 1); break; }
  if (m.type === "probe") (window as any).spikeProbe = m;
  if (m.type === "added") fileDistrict.fill(m.d, m.from, m.to);
}
const hot = () => [Atomics.load(R.seq, R.J + 3), Atomics.load(R.seq, R.J + 4), Atomics.load(R.seq, R.J + 5)];
const waitFrames = (pred: () => boolean, maxMs = 30000) => new Promise<number>((res) => {
  const t0 = performance.now();
  const f = () => (pred() || performance.now() - t0 > maxMs ? res(performance.now() - t0) : requestAnimationFrame(f));
  f();
});
const resetFrame = () => Object.keys(frame).forEach((k) => ((frame as any)[k] = 0));

const spike = {
  pageIsolated: crossOriginIsolated,
  async init(files: number) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = onMsg;
    worker.onerror = (e) => log("worker error " + e.message);
    const p = nextMsg("ready");
    worker.postMessage({ type: "init", files });
    R = await p;
    if (!R.sabOk) return R;
    city = new Float32Array(R.cityBuf.length); district = new Float32Array(R.districtBuf.length); file = new Float32Array(R.fileBuf.length);
    fileDistrict = R.fileDistrict;
    readTier(0, R.cityBuf, city);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let c = 0; c < R.K; c++) {
      x0 = Math.min(x0, city[3 * c] - city[3 * c + 2]); x1 = Math.max(x1, city[3 * c] + city[3 * c + 2]);
      y0 = Math.min(y0, city[3 * c + 1] - city[3 * c + 2]); y1 = Math.max(y1, city[3 * c + 1] + city[3 * c + 2]);
    }
    const m = 0.15 * Math.max(x1 - x0, y1 - y0);
    bounds = { x0: x0 - m, y0: y0 - m, s: canvas.width / (Math.max(x1 - x0, y1 - y0) + 2 * m) };
    requestAnimationFrame(raf);
    const { cityBuf, districtBuf, fileBuf, seq, districtCity, fileDistrict: _fd, ...rest } = R;
    log(`ready: ${files} files, settle ${R.report.settle.totalMs.toFixed(0)} ms, page isolated=${crossOriginIsolated}, worker isolated=${R.crossOriginIsolated}`);
    return rest;
  },
  /** pin city k, move it along a circle for ms, release; report per-loop worker cost. */
  async drag(k = 0, ms = 2000) {
    await waitFrames(() => hot().every((h) => h === 0));
    const cx = city[3 * k], cy = city[3 * k + 1], rad = city[3 * k + 2] * 0.6;
    resetFrame();
    worker.postMessage({ type: "dragStart", city: k });
    const t0 = performance.now();
    await waitFrames(() => {
      const t = (performance.now() - t0) / ms;
      worker.postMessage({ type: "dragMove", city: k, x: cx + Math.sin(t * Math.PI * 2) * rad, y: cy + (1 - Math.cos(t * Math.PI * 2)) * rad * 0.5 });
      return t >= 1;
    });
    const duringFrames = { ...frame };
    const pEnd = nextMsg("dragEnded");
    worker.postMessage({ type: "dragEnd", city: k });
    const ended = await pEnd;
    const tRel = performance.now();
    const restMs = await waitFrames(() => hot().every((h) => h === 0));
    const p = nextMsg("stats");
    worker.postMessage({ type: "getStats", reset: true });
    const st = (await p).stats as any[];
    const during = st.slice(0, ended.statsDuringDrag), after = st.slice(ended.statsDuringDrag);
    const summ = (a: any[]) => a.length ? {
      loops: a.length,
      meanTickMs: a.reduce((s, x) => s + x.tickMs, 0) / a.length,
      maxTickMs: Math.max(...a.map((x) => x.tickMs)),
      meanWriteMs: a.reduce((s, x) => s + x.writeMs, 0) / a.length,
      cityTicks: a.reduce((s, x) => s + x.city, 0),
      districtTicks: a.reduce((s, x) => s + x.district, 0),
      fileTicks: a.reduce((s, x) => s + x.file, 0),
      meanLoopIntervalMs: a.slice(1).reduce((s, x) => s + x.interval, 0) / Math.max(1, a.length - 1),
    } : null;
    return { city: k, dragMs: ms, during: summ(during), afterRelease: summ(after), restAfterReleaseMs: restMs, mainFramesDuringDrag: duringFrames, mainFramesTotal: { ...frame }, sinceRelease: performance.now() - tRel };
  },
  async add(count = 200, mode: "plan" | "stable" = "plan", district?: number) {
    await waitFrames(() => hot().every((h) => h === 0));
    resetFrame();
    const t0 = performance.now();
    const pa = nextMsg("added");
    worker.postMessage({ type: "add", count, mode, district });
    await pa;
    await waitFrames(() => hot().every((h) => h === 0), 60000);
    const wallMs = performance.now() - t0;
    const p = nextMsg("addResult");
    worker.postMessage({ type: "addResult" });
    const r = await p;
    return { ...r, mainWallMs: wallMs, mainFrames: { ...frame } };
  },
  frame,
  hot,
};
(window as any).spike = spike;
log(`page crossOriginIsolated=${crossOriginIsolated}, typeof SharedArrayBuffer=${typeof SharedArrayBuffer}`);
