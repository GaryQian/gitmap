// Imported BEFORE d3-force in the worker: records what d3-timer calls when a simulation is constructed.
export const probe = {
  setTimeout: 0,
  setInterval: 0,
  clearTimeout: 0,
  clearInterval: 0,
  rafCalls: 0,
  hasWindow: typeof (globalThis as any).window === "object",
  hasRAF: typeof (globalThis as any).requestAnimationFrame === "function",
  errors: [] as string[],
  log: [] as string[],
};
const g = globalThis as any;
const st = g.setTimeout, si = g.setInterval, ct = g.clearTimeout, ci = g.clearInterval;
g.setTimeout = (f: any, ms?: number, ...a: any[]) => { probe.setTimeout++; probe.log.push(`setTimeout(${ms}) ${new Error().stack?.split("\n")[2]?.trim() ?? ""}`); return st(f, ms, ...a); };
g.setInterval = (f: any, ms?: number, ...a: any[]) => { probe.setInterval++; probe.log.push(`setInterval(${ms})`); return si(f, ms, ...a); };
g.clearTimeout = (h: any) => { probe.clearTimeout++; return ct(h); };
g.clearInterval = (h: any) => { probe.clearInterval++; probe.log.push("clearInterval"); return ci(h); };
if (probe.hasRAF) {
  const raf = g.requestAnimationFrame;
  g.requestAnimationFrame = (f: any) => { probe.rafCalls++; return raf(f); };
}
g.addEventListener?.("error", (e: any) => probe.errors.push(String(e.message ?? e)));
g.addEventListener?.("unhandledrejection", (e: any) => probe.errors.push(String(e.reason)));
/** Our own scheduler must not be counted: use the originals. */
export const realSetTimeout: typeof setTimeout = st;
