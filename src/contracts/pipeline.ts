// What the app shell sees of the pipeline (PLAN.md §3, §6.8). Implemented by src/pipeline; faked in src/testing.
import type { Config } from '../config';
import type { NodeRef, PatchBatch, RepoModel, Subsystem } from '../model/types';
import type { FileFacts, SyntaxFacts } from './lang';
import type { ContentSource, RepoLocator } from './git';
import type { PhysicsApi } from './physics';
import type { RenderApi } from './render';
import type { ModelReplica } from './store';
import type { RepoStats, StructureTables } from '../model/types';

/** Where a map comes from. */
export type RepoSource =
  /**
   * A folder. When local storage holds a map of it, that map is shown instead of parsing (PLAN.md §12);
   * `fresh` parses regardless and ignores cached parse facts ("parse again").
   */
  | { kind: 'directory'; locator: RepoLocator; fresh?: boolean }
  /** A saved or imported model; `locator` is present when the folder is also available. */
  | { kind: 'snapshot'; model: RepoModel; locator?: RepoLocator }
  /** A demo: base URL holding snapshot.starmap.json.gz and content.zip. */
  | { kind: 'demo'; name: string; baseUrl: string }
  | { kind: 'synthetic'; files: number; seed?: number };

export interface AttachOptions { theme?: 'dark' | 'light'; particles?: boolean; reducedMotion?: boolean }

export type Stage =
  | 'idle' | 'manifest' | 'reading' | 'structure' | 'layout' | 'revealed' | 'failed';

/** Human-readable stage line for the waiting screen, for example "Reading files 6,214 / 10,000". */
export interface StageInfo { stage: Stage; label: string; done?: number; total?: number }

export type Notice =
  /** The slow pass finished after an imports-only reveal: offer "Refined structure ready · Apply". */
  | { kind: 'refined-ready' }
  /** Files differ from the saved map or the index: offer "N files changed · Update". */
  | { kind: 'files-changed'; count: number }
  | { kind: 'no-history'; reason: string }
  | { kind: 'info'; message: string }
  | { kind: 'cleared'; which: 'refined-ready' | 'files-changed' };

export interface PipelineEvents {
  stage: StageInfo;
  progress: { subsystem: Subsystem; done: number; total: number; label?: string };
  /** A batch was applied to the replica (and forwarded to renderer and physics). */
  batch: PatchBatch;
  /** The map is settled and may be shown. */
  reveal: { structure: 'full' | 'imports-only' };
  notice: Notice;
  error: { message: string; fatal: boolean };
}

export interface SearchHit { ref: NodeRef; path: string; score: number }

/**
 * One open map. Owns the coordinator, the pool, the physics client and (once a canvas is attached)
 * the renderer. The React shell talks only to this.
 */
export interface Session {
  readonly source: RepoSource;
  readonly config: Config;
  /** Main-thread view replica, kept in step with the store. */
  readonly replica: ModelReplica;
  readonly physics: PhysicsApi;
  /** Null until attachCanvas. */
  readonly render: RenderApi | null;
  /** Null when file contents are unavailable (an imported map with no folder). */
  readonly content: ContentSource | null;
  readonly stage: StageInfo;
  /**
   * Create the renderer on a canvas. May be called before or after the reveal. `opts` carries the
   * viewer's saved preferences; anything omitted falls back to config.settings.
   */
  attachCanvas(canvas: HTMLCanvasElement, opts?: AttachOptions): RenderApi;
  /** Begin loading or parsing. Resolves at the reveal; rejects on a fatal error. */
  start(): Promise<void>;
  on<E extends keyof PipelineEvents>(evt: E, fn: (e: PipelineEvents[E]) => void): () => void;
  /** "Refined structure ready · Apply": recompute importance and clustering, one animated re-layout. */
  applyRefined(): Promise<void>;
  /** "N files changed · Update": re-parse changed files and apply them in one animated step. */
  update(): Promise<void>;
  /**
   * "Load full history": walk the history again without the commit and time caps (PLAN.md §6.5).
   * Resolves when the walk has ended. Absent where there is no history to walk (fakes).
   */
  loadFullHistory?(): Promise<void>;
  /** The overlay the user is looking at, so its producer is promoted (PLAN.md §3.1). */
  setSelectedOverlay(layer: string | null): void;
  /** Report frame time so the coordinator can park background work while the user interacts. */
  reportFrame(frameMs: number, interacting: boolean): void;
  search(query: string, limit?: number): Promise<SearchHit[]>;
  /** The current model as one document (export, snapshot). */
  exportModel(): Promise<RepoModel>;
  dispose(): void;
}

// ---- pure pipeline stages, shared by the browser coordinator and the Node scripts ----

export interface AnalysisInput {
  repoName: string;
  files: FileFacts[];
  /** Slow-pass facts for some or all files. Absent or partial → structure 'imports-only'. */
  syntax?: SyntaxFacts[];
  /** True when `syntax` covers every file that has a slow pass. */
  syntaxComplete?: boolean;
  /**
   * Current memberships and names, so a re-run keeps ids stable where communities persist
   * (Apply, Update). Keys are unit ids / district ids.
   */
  previous?: {
    unitDistrict: Record<string, string>;
    districtCity: Record<string, string>;
    districtName: Record<string, string>;
    cityName: Record<string, string>;
  };
}

export interface AnalysisResult {
  /** The structure the model should have. The pipeline diffs it against the store and proposes the difference. */
  tables: StructureTables;
  structure: 'full' | 'imports-only';
  stats: RepoStats;
  diagnostics: {
    importsTotal: number;
    importsResolved: number;
    refsLinked: number;
    refsDropped: number;
    bridges: number;
    ms: Record<string, number>;
  };
}

/** src/analysis exports `analyze` with this signature. Pure and synchronous; runs as a pool task. */
export type Analyze = (input: AnalysisInput, config: Config) => AnalysisResult;
