// Typed loader for config.json (PLAN.md §13). One file, imported by client, workers, scripts and
// server functions alike. Secrets never live here.
import raw from '../../config.json';

export interface DemoRepo { name: string; path: string; location?: string }
export type ThemeMode = 'dark' | 'light';
export type ThemeTokens = (typeof raw)['theme']['dark'];

export type Config = Omit<typeof raw, 'demo' | 'visual'> & {
  demo: { repos: DemoRepo[] };
  visual: Omit<(typeof raw)['visual'], 'languageColors'> & { languageColors: Record<string, string> };
};

/** Recursively-optional Config, for overrides in tests and the dev tuning panel. */
export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, over: unknown): T {
  if (over === undefined) return base;
  if (!isPlain(base) || !isPlain(over)) return over as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge((base as Record<string, unknown>)[k], v);
  return out as T;
}

/** Throws with a readable message when config.json is malformed. Checks shape and a few invariants. */
export function validateConfig(c: Config): Config {
  const fail = (msg: string): never => { throw new Error(`config.json: ${msg}`); };
  const num = (path: string, v: unknown, min = -Infinity, max = Infinity) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${path} must be a number in [${min}, ${max}]`);
  };
  if (!c.app?.title) fail('app.title is required');
  if (c.settings.appearance !== 'dark' && c.settings.appearance !== 'light' && c.settings.appearance !== 'system') fail('settings.appearance must be dark, light or system');
  num('scheduler.maxWorkers', c.scheduler.maxWorkers, 1, 64);
  num('scheduler.parseFloorWorkers', c.scheduler.parseFloorWorkers, 0, 64);
  num('reveal.maxWaitSeconds', c.reveal.maxWaitSeconds, 0);
  num('clustering.citiesPerDecade', c.clustering.citiesPerDecade);
  num('clustering.minDistrictSize', c.clustering.minDistrictSize, 1);
  num('physics.file.sizeVsConnectivity', c.physics.file.sizeVsConnectivity, 0, 1);
  num('visual.radiusMin', c.visual.radiusMin, 0);
  num('visual.radiusMax', c.visual.radiusMax, c.visual.radiusMin);
  num('visual.glowFromPct', c.visual.glowFromPct, 0, 1);
  num('visual.sizeScale', c.visual.sizeScale, 0);
  num('visual.importanceBoost', c.visual.importanceBoost, 0);
  num('visual.importanceCurve', c.visual.importanceCurve, 0);
  num('scheduler.workerShare', c.scheduler.workerShare, 0, 1);
  if (!['skip', 'firstParent', 'include'].includes(c.history.merges)) fail('history.merges must be skip, firstParent or include');
  num('history.progressIntervalMs', c.history.progressIntervalMs, 0);
  num('persist.snapshotDebounceMs', c.persist.snapshotDebounceMs, 0);
  if (typeof c.parser.version !== 'string' || !c.parser.version) fail('parser.version must be a non-empty string');
  const strings = (path: string, v: unknown) => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) fail(`${path} must be a list of non-empty strings`);
  };
  strings('parser.bridges', c.parser.bridges);
  strings('ai.excludePaths', c.ai.excludePaths);
  const split = c.ai.budgetSplit.structure + c.ai.budgetSplit.skeletons + c.ai.budgetSplit.docs;
  if (Math.abs(split - 1) > 1e-6) fail('ai.budgetSplit must sum to 1');
  if (c.ai.tour.minSteps > c.ai.tour.maxSteps) fail('ai.tour.minSteps must not exceed maxSteps');
  for (const mode of ['dark', 'light'] as const) {
    for (const [k, v] of Object.entries(c.theme[mode])) if (!/^#[0-9a-fA-F]{6}$/.test(v)) fail(`theme.${mode}.${k} must be a #rrggbb colour`);
  }
  return c;
}

/** The project configuration. Treat as immutable. */
export const config: Config = validateConfig(raw as unknown as Config);

/** A copy of the config with overrides applied (tests, dev tuning panel). */
export function withConfig(over: DeepPartial<Config>): Config {
  return validateConfig(merge(config, over));
}
