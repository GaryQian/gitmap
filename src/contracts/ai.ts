// AI layer contracts (PLAN.md §11). The browser builds context; the server is a thin, stateless proxy.
import type { NodeRef, PoiKind } from '../model/types';

export type ModelRole = 'synthesis' | 'bulk';

export interface GenerateRequest {
  role: ModelRole;
  system: string;
  /** Stable context shared between calls; providers that support prompt caching cache it. */
  cachedPrefix?: string;
  prompt: string;
  /** JSON Schema the structured result must satisfy. */
  schema: Record<string, unknown>;
  maxOutputTokens: number;
}
export interface GenerateResult<T = unknown> {
  value: T | null;
  /** 'ok' | 'refusal' | 'max_tokens' | 'invalid' — refusals and truncation are explicit, never thrown. */
  outcome: 'ok' | 'refusal' | 'max_tokens' | 'invalid';
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}

/** One model provider. The Anthropic adapter is the default; others implement the same interface. */
export interface AiProvider {
  readonly id: string;
  generate<T = unknown>(req: GenerateRequest): Promise<GenerateResult<T>>;
  /** Count input tokens without generating, for the per-request cap. May estimate. */
  countTokens(text: string): Promise<number>;
}

// ---- /api/ai/* request and response bodies ----

export interface AiRequestBase {
  /** Hash of the repo digest; keys caches and the per-digest detail cap. */
  digestHash: string;
  /** Every NodeRef the model may cite. Items citing anything else are dropped by the server. */
  refs: NodeRef[];
}

/** POST /api/ai/summaries — one call per city (the client fans out). */
export interface SummariesRequest extends AiRequestBase {
  city: NodeRef;
  /** City context built by the digest builder. */
  context: string;
}
export interface SummariesResponse { summary: { parent: NodeRef; label: string; text: string } | null }

export interface CitySummary { parent: NodeRef; label: string; text: string }

/** POST /api/ai/pois */
export interface PoisRequest extends AiRequestBase {
  digest: string;
  summaries: CitySummary[];
  count: number;
}
export interface PoiItem { parent: NodeRef; label: string; summary: string; kind: PoiKind; evidence: string; refs: NodeRef[] }
export interface PoisResponse { pois: PoiItem[] }

/** POST /api/ai/tour */
export interface TourRequest extends AiRequestBase {
  digest: string;
  summaries: CitySummary[];
  minSteps: number;
  maxSteps: number;
}
export interface TourResponse { steps: { target: NodeRef; text: string; highlights: NodeRef[] }[] }

export const DETAIL_QUESTIONS = {
  role: 'Role in the system',
  users: 'Who uses this',
  entry: 'Key entry points',
  walkthrough: 'Walk me through it',
} as const;
export type DetailQuestion = keyof typeof DETAIL_QUESTIONS;

/** POST /api/ai/detail */
export interface DetailRequest extends AiRequestBase {
  poi: { parent: NodeRef; label: string; summary: string };
  question: DetailQuestion;
  /** The file's skeleton or content plus its neighbours' signatures. */
  context: string;
}
export interface DetailResponse { markdown: string }

export interface AiErrorBody { error: { code: 'disabled' | 'no_key' | 'too_large' | 'rate_limited' | 'refused' | 'invalid' | 'provider'; message: string } }
