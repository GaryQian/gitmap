// Schemas for the four routes: zod for the request bodies and for what the model sends back, and the
// JSON Schemas given to the provider for structured output.
import { z } from 'zod';
import type { Config } from '../../config';
import { DETAIL_QUESTIONS } from '../../contracts/ai';
import type { DetailQuestion, DetailRequest, PoisRequest, SummariesRequest, TourRequest } from '../../contracts/ai';
import { isNodeRef } from '../../model/types';
import type { NodeRef, PoiKind } from '../../model/types';

export const POI_KINDS = ['entry', 'core', 'boundary', 'data', 'risk'] as const satisfies readonly PoiKind[];

// ---- request bodies ----

const nodeRef = z.custom<NodeRef>(isNodeRef, 'must be a node reference such as "u:src/main.ts"');
const text = z.string().min(1);
const base = { digestHash: z.string().min(1).max(256), refs: z.array(nodeRef) };
const citySummary = z.object({ parent: nodeRef, label: z.string(), text: z.string() });

export function summariesRequest(_config: Config): z.ZodType<SummariesRequest> {
  return z.object({ ...base, city: nodeRef, context: text });
}

export function poisRequest(config: Config): z.ZodType<PoisRequest> {
  return z.object({
    ...base,
    digest: text,
    summaries: z.array(citySummary),
    count: z.number().int().min(1).max(config.ai.pois.max),
  });
}

export function tourRequest(config: Config): z.ZodType<TourRequest> {
  return z
    .object({
      ...base,
      digest: text,
      summaries: z.array(citySummary),
      minSteps: z.number().int().min(1),
      maxSteps: z.number().int().max(config.ai.tour.maxSteps),
    })
    .refine((r) => r.minSteps <= r.maxSteps, { message: 'minSteps must not exceed maxSteps', path: ['minSteps'] });
}

export function detailRequest(_config: Config): z.ZodType<DetailRequest> {
  return z.object({
    ...base,
    poi: z.object({ parent: nodeRef, label: z.string(), summary: z.string() }),
    question: z.enum(Object.keys(DETAIL_QUESTIONS) as [DetailQuestion, ...DetailQuestion[]]),
    context: text,
  });
}

// ---- structured output: JSON Schemas for the provider ----
//
// Only keywords structured outputs support: no string or array length limits (lengths and counts are
// stated in prompts.ts and checked in the handlers), every property required, additionalProperties false.

type JsonSchema = Record<string, unknown>;

const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const string = (description: string): JsonSchema => ({ type: 'string', description });
const refList = (description: string): JsonSchema => ({ type: 'array', items: { type: 'string' }, description });

export const SUMMARY_SCHEMA = object({
  label: string('A short name for the role this city plays.'),
  text: string('What this city contains and the role it plays.'),
});

const POI_ITEM = object({
  parent: string('The allowed reference this point of interest is attached to.'),
  label: string('A short name.'),
  summary: string('Its role and how it connects to the rest.'),
  kind: { type: 'string', enum: [...POI_KINDS] },
  evidence: string('One structural fact from the provided material that supports this choice.'),
  refs: refList('Other allowed references this point of interest relates to. May be empty.'),
});

const TOUR_STEP = object({
  target: string('The allowed reference this step shows.'),
  text: string('What happens here and how it leads on, including one structural fact.'),
  highlights: refList('Other allowed references to light up during this step. May be empty.'),
});

/**
 * One schema for both reduce calls. Points of interest and the tour are separate requests over the
 * same digest, and changing the output format invalidates the prompt cache, so they share a format
 * and each call fills only its own half (the prompt says which; the other array comes back empty).
 */
export const REDUCE_SCHEMA = object({
  pois: { type: 'array', items: POI_ITEM },
  steps: { type: 'array', items: TOUR_STEP },
});

export const DETAIL_SCHEMA = object({
  markdown: string('The answer as Markdown.'),
});

// ---- structured output: what came back ----
//
// Lenient on purpose: these only establish the shape. References, kinds, lengths and counts are
// checked item by item in the handlers so one bad item does not sink the rest.

export const summaryOutput = z.object({ label: z.string(), text: z.string() });

const poiOutput = z.object({
  parent: z.string(),
  label: z.string(),
  summary: z.string(),
  kind: z.string(),
  evidence: z.string(),
  refs: z.array(z.string()).default([]),
});
const stepOutput = z.object({
  target: z.string(),
  text: z.string(),
  highlights: z.array(z.string()).default([]),
});
export const reduceOutput = z.object({
  pois: z.array(poiOutput).default([]),
  steps: z.array(stepOutput).default([]),
});
export type PoiOutput = z.infer<typeof poiOutput>;
export type StepOutput = z.infer<typeof stepOutput>;

export const detailOutput = z.object({ markdown: z.string() });
