// The four /api/ai/* handlers (PLAN.md §11.1): thin and stateless. The browser builds the context;
// a handler checks the request and its size, calls the provider, validates the structured result,
// drops anything that cites unknown references or stands on something other than a file, and returns it.
//
// Handlers are pure functions of (Request, Deps) so the same code runs as a Vercel Function, in the
// Vite dev server and in tests.
import type { z } from 'zod';
import type { Config } from '../../config';
import type {
  AiProvider, DetailRequest, DetailResponse, GenerateRequest, GenerateResult, PoiItem, PoisRequest,
  PoisResponse, SummariesRequest, SummariesResponse, TourRequest, TourResponse,
} from '../../contracts/ai';
import type { NodeRef, PoiKind, TourFrame, UnitRef } from '../../model/types';
import { AiError, errorResponse, jsonResponse } from './errors';
import { clientIp } from './limiter';
import type { Limiter } from './limiter';
import {
  LENGTHS, SYSTEM, detailPrefix, detailPrompt, poisPrompt, reducePrefix, retryPrompt, summaryPrompt, tourPrompt,
} from './prompts';
import { estimateTokens } from './provider';
import {
  DETAIL_SCHEMA, POI_KINDS, REDUCE_SCHEMA, SUMMARY_SCHEMA, TOUR_FRAMES, detailOutput, detailRequest, isUnitRef,
  poisRequest, reduceOutput, summariesRequest, summaryOutput, tourRequest,
} from './schemas';

export type RouteName = 'summaries' | 'pois' | 'tour' | 'detail';

export interface Deps {
  /** The provider, or the reason there is none (AiError 'no_key' when the key is missing). */
  provider: AiProvider | AiError;
  config: Config;
  limiter: Limiter;
  now: () => number;
  /** Called after each provider call; the cached share shows whether the prompt cache is being hit. */
  onUsage?: (route: RouteName, usage: GenerateResult['usage']) => void;
}

export type Handler = (request: Request, deps: Deps) => Promise<Response>;

/**
 * Server limits that have no config.json entry yet. They sit here, in one place, until the lead
 * adds them to the `ai` block.
 */
export const LIMITS = {
  /** Requests per client IP, per window, across one route. */
  ip: { requests: 60, windowMs: 60_000 },
  /** How long a digest's detail-call count is remembered. */
  detailWindowMs: 24 * 60 * 60 * 1000,
  /** Output budget per call. Includes the model's thinking, so it is far above the visible reply. */
  maxOutputTokens: { summaries: 8000, pois: 16000, tour: 16000, detail: 16000 },
  /** Below this share of the input cap the local estimate is trusted; above it the provider counts. */
  countAbove: 0.7,
  /** Above this multiple of the cap the local estimate alone rejects the request. */
  rejectAbove: 1.5,
  /** Same, for the raw request body, which also carries fields that never reach the prompt. */
  bodyRejectAbove: 3,
  /** Calls after the first, when a reply breaks the length or count rules. */
  retries: 1,
  /** Problems quoted back to the model on a retry. */
  maxProblemsQuoted: 12,
} as const;

interface Ctx {
  route: RouteName;
  deps: Deps;
  provider: AiProvider;
}

// ---- the shared request path ----

function route<Req, Res>(
  name: RouteName,
  schemaFor: (config: Config) => z.ZodType<Req>,
  run: (body: Req, ctx: Ctx) => Promise<Res>,
): Handler {
  return async (request, deps) => {
    try {
      const { config } = deps;
      if (!config.ai.enabled) throw new AiError('disabled', 'AI features are turned off on this server.');
      if (deps.provider instanceof AiError) throw deps.provider;
      if (request.method !== 'POST') {
        throw new AiError('invalid', 'Use POST.', { status: 405, headers: { allow: 'POST' } });
      }
      await enforceLimit(deps, `ip:${name}:${clientIp(request)}`, LIMITS.ip.requests, LIMITS.ip.windowMs,
        'Too many AI requests from this address. Try again shortly.');

      // Cheap size check before parsing; the exact check on the built prompt is in ensureFits.
      const raw = await request.text();
      if (estimateTokens(raw) > config.ai.maxInputTokens * LIMITS.bodyRejectAbove) throw tooLarge(config);

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new AiError('invalid', 'The request body is not valid JSON.');
      }
      const parsed = schemaFor(config).safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
        throw new AiError('invalid', `Invalid request: ${issues.join('; ')}`);
      }
      return jsonResponse(await run(parsed.data, { route: name, deps, provider: deps.provider }));
    } catch (e) {
      if (e instanceof AiError) return errorResponse(e);
      console.error(`[ai] ${name} failed`, e);
      return errorResponse(new AiError('provider', 'The AI request failed.'));
    }
  };
}

async function enforceLimit(deps: Deps, key: string, limit: number, windowMs: number, message: string): Promise<void> {
  const r = await deps.limiter.hit(key, limit, windowMs, deps.now());
  if (!r.allowed) {
    throw new AiError('rate_limited', message, { headers: { 'retry-after': String(Math.ceil(r.retryAfterMs / 1000)) } });
  }
}

function tooLarge(config: Config): AiError {
  return new AiError('too_large', `The request is larger than the ${config.ai.maxInputTokens}-token input limit.`);
}

/** Enforce `config.ai.maxInputTokens`: estimate first, ask the provider to count only near the cap. */
async function ensureFits(ctx: Ctx, req: Pick<GenerateRequest, 'system' | 'cachedPrefix' | 'prompt'>): Promise<void> {
  const cap = ctx.deps.config.ai.maxInputTokens;
  const text = [req.system, req.cachedPrefix ?? '', req.prompt].join('\n\n');
  const estimate = estimateTokens(text);
  if (estimate > cap * LIMITS.rejectAbove) throw tooLarge(ctx.deps.config);
  if (estimate >= cap * LIMITS.countAbove && (await ctx.provider.countTokens(text)) > cap) throw tooLarge(ctx.deps.config);
}

// ---- generate, check, retry once ----

interface Checked<T> {
  value: T;
  /** How much of the reply was usable; the better of two attempts is kept. */
  score: number;
  /** Length and count violations. Any of these triggers the retry. */
  problems: string[];
  /** Things that were dropped without needing a retry; quoted to the model if one happens anyway. */
  notes: string[];
}

async function generateChecked<T>(
  ctx: Ctx,
  req: Omit<GenerateRequest, 'system'>,
  check: (raw: unknown) => Checked<T>,
  unusable: T,
): Promise<T> {
  const base: GenerateRequest = { ...req, system: SYSTEM };
  await ensureFits(ctx, base);

  let best: Checked<T> | null = null;
  let prompt = base.prompt;
  for (let attempt = 0; attempt <= LIMITS.retries; attempt++) {
    const res = await ctx.provider.generate({ ...base, prompt });
    ctx.deps.onUsage?.(ctx.route, res.usage);
    if (res.outcome === 'refusal') throw new AiError('refused', 'The model declined to answer this request.');
    if (res.outcome === 'max_tokens') throw new AiError('provider', 'The model ran out of room before finishing its answer.');

    const checked: Checked<T> = res.outcome === 'ok'
      ? check(res.value)
      : { value: unusable, score: -1, problems: ['The reply was not valid JSON for the requested format.'], notes: [] };
    if (!best || checked.score >= best.score) best = checked;
    if (checked.problems.length === 0) break;
    const quoted = [...checked.problems, ...checked.notes].slice(0, LIMITS.maxProblemsQuoted);
    prompt = retryPrompt(base.prompt, res.value, quoted);
  }
  return best!.value;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function labelProblem(where: string, label: string): string | null {
  const n = wordCount(label);
  if (n >= 1 && n <= LENGTHS.label.tolerated) return null;
  return `${where} has ${n} words; a label is 1 to ${LENGTHS.label.max} words.`;
}

function lengthProblem(where: string, text: string, tolerated: readonly [number, number], ask: string): string | null {
  const n = wordCount(text);
  if (n >= tolerated[0] && n <= tolerated[1]) return null;
  return `${where} has ${n} words; write ${ask}.`;
}

const shapeProblem = <T>(value: T): Checked<T> => ({
  value, score: -1, problems: ['The reply did not have the requested fields.'], notes: [],
});

/**
 * Points of interest and tour steps always stand on a file (PLAN.md §11.3): the parent must be a
 * `u:` reference and one of the request's. A district or city is refused even when it is in the list.
 */
function standsOnFile(parent: string, allowed: ReadonlySet<string>): parent is UnitRef {
  return isUnitRef(parent) && allowed.has(parent);
}

function parentNote(where: string, parent: string, what: string): string {
  return `${where}.parent "${parent}" is not a file reference (u:) from the allowed list, so the ${what} was discarded.`;
}

// ---- summaries ----

type CityLabel = { label: string; text: string };

function checkSummary(raw: unknown): Checked<CityLabel | null> {
  const parsed = summaryOutput.safeParse(raw);
  if (!parsed.success) return shapeProblem(null);
  const label = parsed.data.label.trim();
  const text = parsed.data.text.trim();
  const problems = [
    labelProblem('label', label),
    lengthProblem('text', text, LENGTHS.summary.tolerated, `about ${LENGTHS.summary.target} words`),
  ].filter((p) => p !== null);
  return problems.length ? { value: null, score: 0, problems, notes: [] } : { value: { label, text }, score: 1, problems, notes: [] };
}

const summaries = route<SummariesRequest, SummariesResponse>('summaries', summariesRequest, async (body, ctx) => {
  const result = await generateChecked(ctx, {
    role: 'bulk',
    prompt: summaryPrompt(body),
    schema: SUMMARY_SCHEMA,
    maxOutputTokens: LIMITS.maxOutputTokens.summaries,
  }, checkSummary, null);
  return { summary: result && { parent: body.city, ...result } };
});

// ---- points of interest ----

function checkPois(raw: unknown, allowed: ReadonlySet<string>, count: number): Checked<PoiItem[]> {
  const parsed = reduceOutput.safeParse(raw);
  if (!parsed.success) return shapeProblem([]);
  const valid: PoiItem[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  parsed.data.pois.forEach((p, i) => {
    const where = `pois[${i}]`;
    const parent = p.parent;
    if (!standsOnFile(parent, allowed)) {
      notes.push(parentNote(where, parent, 'item'));
      return;
    }
    const kind = p.kind.trim().toLowerCase(); // enum casing is not guaranteed by structured outputs
    const label = p.label.trim();
    const summary = p.summary.trim();
    const evidence = p.evidence.trim();
    const itemProblems = [
      labelProblem(`${where}.label`, label),
      lengthProblem(`${where}.summary`, summary, LENGTHS.summary.tolerated, `about ${LENGTHS.summary.target} words`),
      (POI_KINDS as readonly string[]).includes(kind) ? null : `${where}.kind must be one of ${POI_KINDS.join(', ')}.`,
      evidence ? null : `${where}.evidence is empty; give one structural fact.`,
    ].filter((x) => x !== null);
    if (itemProblems.length) {
      problems.push(...itemProblems);
      return;
    }
    const refs = p.refs.filter((r) => allowed.has(r));
    if (refs.length < p.refs.length) notes.push(`${where}.refs had references that are not allowed; they were removed.`);
    valid.push({ parent, label, summary, kind: kind as PoiKind, evidence, refs: refs as NodeRef[] });
  });
  if (valid.length !== count) {
    problems.push(`${valid.length} usable points of interest were returned; return exactly ${count}.`);
  }
  return { value: valid.slice(0, count), score: Math.min(valid.length, count), problems, notes };
}

const pois = route<PoisRequest, PoisResponse>('pois', poisRequest, async (body, ctx) => {
  const allowed = new Set<string>(body.refs);
  const items = await generateChecked(ctx, {
    role: 'synthesis',
    cachedPrefix: reducePrefix(body),
    prompt: poisPrompt(body),
    schema: REDUCE_SCHEMA,
    maxOutputTokens: LIMITS.maxOutputTokens.pois,
  }, (raw) => checkPois(raw, allowed, body.count), []);
  return { pois: items };
});

// ---- tour ----

type Step = TourResponse['steps'][number];

function checkTour(raw: unknown, allowed: ReadonlySet<string>, minSteps: number, maxSteps: number): Checked<Step[]> {
  const parsed = reduceOutput.safeParse(raw);
  if (!parsed.success) return shapeProblem([]);
  const valid: Step[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  parsed.data.steps.forEach((s, i) => {
    const where = `steps[${i}]`;
    const parent = s.parent;
    if (!standsOnFile(parent, allowed)) {
      notes.push(parentNote(where, parent, 'step'));
      return;
    }
    const text = s.text.trim();
    const problem = lengthProblem(`${where}.text`, text, LENGTHS.step.tolerated, `${LENGTHS.step.min} to ${LENGTHS.step.max} words`);
    if (problem) {
      problems.push(problem);
      return;
    }
    // The frame only says how wide the camera looks, and the file itself is always a valid thing to
    // show, so a frame that is not one of the three falls back to 'file' instead of costing the step.
    const asked = s.frame.trim().toLowerCase(); // enum casing is not guaranteed by structured outputs
    const known = (TOUR_FRAMES as readonly string[]).includes(asked);
    const frame: TourFrame = known ? (asked as TourFrame) : 'file';
    if (!known) notes.push(`${where}.frame must be one of ${TOUR_FRAMES.join(', ')}; file was used.`);
    const highlights = s.highlights.filter((r): r is UnitRef => standsOnFile(r, allowed));
    if (highlights.length < s.highlights.length) {
      notes.push(`${where}.highlights had references that are not allowed file references (u:); they were removed.`);
    }
    valid.push({ parent, frame, text, highlights });
  });
  if (valid.length < minSteps || valid.length > maxSteps) {
    problems.push(`${valid.length} usable steps were returned; write ${minSteps} to ${maxSteps}.`);
  }
  return { value: valid.slice(0, maxSteps), score: Math.min(valid.length, maxSteps), problems, notes };
}

const tour = route<TourRequest, TourResponse>('tour', tourRequest, async (body, ctx) => {
  const allowed = new Set<string>(body.refs);
  const steps = await generateChecked(ctx, {
    role: 'synthesis',
    cachedPrefix: reducePrefix(body),
    prompt: tourPrompt(body),
    schema: REDUCE_SCHEMA,
    maxOutputTokens: LIMITS.maxOutputTokens.tour,
  }, (raw) => checkTour(raw, allowed, body.minSteps, body.maxSteps), []);
  if (steps.length < body.minSteps) throw new AiError('provider', 'The model did not produce a usable tour.');
  return { steps };
});

// ---- detail ----

function checkDetail(raw: unknown): Checked<string> {
  const parsed = detailOutput.safeParse(raw);
  if (!parsed.success) return shapeProblem('');
  const markdown = parsed.data.markdown.trim();
  return markdown
    ? { value: markdown, score: 1, problems: [], notes: [] }
    : { value: '', score: 0, problems: ['The answer was empty.'], notes: [] };
}

const detail = route<DetailRequest, DetailResponse>('detail', detailRequest, async (body, ctx) => {
  const { config } = ctx.deps;
  await enforceLimit(ctx.deps, `detail:${body.digestHash}`, config.ai.maxDetailCallsPerDigest, LIMITS.detailWindowMs,
    'The detail limit for this repository has been reached.');
  const markdown = await generateChecked(ctx, {
    role: 'synthesis',
    cachedPrefix: detailPrefix(body),
    prompt: detailPrompt(body),
    schema: DETAIL_SCHEMA,
    maxOutputTokens: LIMITS.maxOutputTokens.detail,
  }, checkDetail, '');
  if (!markdown) throw new AiError('provider', 'The model did not produce an answer.');
  return { markdown };
});

export const handlers: Record<RouteName, Handler> = { summaries, pois, tour, detail };
