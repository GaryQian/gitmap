// The OpenAI adapter (PLAN.md §11.1): the Responses API over plain `fetch`, no SDK.
//
// What the request relies on, from the OpenAI documentation:
//   - POST /v1/responses with the result format in `text.format` (`type: 'json_schema'`, `strict`).
//   - A refusal is a `refusal` part in the output message; a reply cut off by `max_output_tokens`
//     (which also covers the model's reasoning) has `status: 'incomplete'` and says why in
//     `incomplete_details.reason`.
//   - Prompt caching reuses a prefix only up to a breakpoint, and the whole rendered prefix up to it
//     must match (model, result format, and every message before it). Top-level `instructions` are
//     not part of that prefix on the current models, so the system prompt goes in as the first
//     developer message instead.
import type { Config } from '../../config';
import type { AiProvider, GenerateRequest, GenerateResult } from '../../contracts/ai';
import { tierModels } from '../active';
import { estimateTokens } from '../tokens';
import { AiError } from './errors';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** `text.format.name` is required; it is constant so it never disturbs the cached prefix. */
const FORMAT_NAME = 'result';
/** The API rejects a smaller `max_output_tokens`. */
const MIN_OUTPUT_TOKENS = 16;

export interface OpenAiProviderOptions {
  apiKey: string;
  config: Config;
  /** Replaces the HTTP transport; tests use it to stay off the network. Default: the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * Mark the end of `cachedPrefix` as an explicit cache breakpoint (default true). Models older
   * than the ones that support breakpoints may reject the field; false sends the same text without it.
   */
  cacheBreakpoint?: boolean;
  /** Default: https://api.openai.com/v1 */
  baseUrl?: string;
}

type Json = Record<string, unknown>;

function isPlain(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---- the schema rules of strict structured outputs ----

const UNSUPPORTED_KEYWORDS = ['allOf', 'not', 'dependentRequired', 'dependentSchemas', 'if', 'then', 'else'] as const;

/**
 * Why a schema does not qualify for `strict: true`, or an empty list when it does. The rules
 * checked: the root is an object and not an `anyOf`; every object sets `additionalProperties: false`
 * and lists every property under `required`; none of the unsupported keywords appear. (The size
 * limits, such as ten levels of nesting, are not checked.)
 *
 * The server's schemas qualify as written, so nothing is converted. A schema that does not is sent
 * with `strict: false`, where the model follows it as well as it can and `matchesSchema` checks the reply.
 */
export function strictSchemaIssues(schema: Json): string[] {
  const issues: string[] = [];
  if (schema.type !== 'object') issues.push('$: the root must have type "object"');
  if ('anyOf' in schema) issues.push('$: the root cannot be an anyOf');

  const visit = (node: unknown, path: string): void => {
    if (!isPlain(node)) return;
    for (const k of UNSUPPORTED_KEYWORDS) if (k in node) issues.push(`${path}: "${k}" is not supported`);
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes('object') || isPlain(node.properties)) {
      if (node.additionalProperties !== false) issues.push(`${path}: additionalProperties must be false`);
      const properties = isPlain(node.properties) ? node.properties : {};
      const required = new Set<unknown>(Array.isArray(node.required) ? node.required : []);
      for (const [k, sub] of Object.entries(properties)) {
        if (!required.has(k)) issues.push(`${path}.${k}: every property must be listed in required`);
        visit(sub, `${path}.${k}`);
      }
    }
    if (node.items !== undefined) visit(node.items, `${path}[]`);
    if (Array.isArray(node.anyOf)) node.anyOf.forEach((sub, i) => visit(sub, `${path}.anyOf[${i}]`));
    if (isPlain(node.$defs)) for (const [k, sub] of Object.entries(node.$defs)) visit(sub, `${path}.$defs.${k}`);
  };
  visit(schema, '$');
  return issues;
}

function hasType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'object': return isPlain(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

/**
 * Whether a parsed reply has the shape the schema asks for: types, required properties, array
 * items, `anyOf`. Deliberately not a full validator: enum values, formats and `$ref` are left to
 * the handlers, which check item by item so one off value does not cost the whole reply.
 */
export function matchesSchema(value: unknown, schema: unknown): boolean {
  if (!isPlain(schema)) return true;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((sub) => matchesSchema(value, sub))) return false;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => hasType(value, t))) return false;
  }
  if (isPlain(value) && isPlain(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((k) => typeof k === 'string' && !(k in value))) return false;
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in value && !matchesSchema(value[k], sub)) return false;
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) return value.every((v) => matchesSchema(v, schema.items));
  return true;
}

// ---- the request ----

function requestBody(req: GenerateRequest, model: string, cacheBreakpoint: boolean): Json {
  // Order is what caching depends on: system prompt, then the shared context, then the part that
  // varies. The breakpoint sits at the end of the shared context, so two calls with the same
  // system prompt, schema and `cachedPrefix` (points of interest and the tour; a retry) share
  // everything before it. In explicit mode nothing after the breakpoint is written to the cache.
  const mark = Boolean(req.cachedPrefix) && cacheBreakpoint;
  const user: Json[] = [];
  if (req.cachedPrefix) {
    user.push({ type: 'input_text', text: req.cachedPrefix, ...(mark ? { prompt_cache_breakpoint: { mode: 'explicit' } } : {}) });
  }
  user.push({ type: 'input_text', text: req.prompt });

  return {
    model,
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: req.system }] },
      { role: 'user', content: user },
    ],
    text: {
      format: { type: 'json_schema', name: FORMAT_NAME, schema: req.schema, strict: strictSchemaIssues(req.schema).length === 0 },
    },
    // Reasoning is left at the model's default and is counted against this limit.
    max_output_tokens: Math.max(MIN_OUTPUT_TOKENS, Math.floor(req.maxOutputTokens)),
    // Code excerpts are not kept on the provider's side as stored responses.
    store: false,
    ...(mark ? { prompt_cache_options: { mode: 'explicit' } } : {}),
  };
}

// ---- the reply ----

interface ResponseBody {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
  output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } | null } | null;
}

function readReply<T>(body: ResponseBody, schema: Json): GenerateResult<T> {
  const cached = body.usage?.input_tokens_details?.cached_tokens;
  const usage: GenerateResult['usage'] = {
    // `input_tokens` is the whole prompt; cache reads and writes are parts of it, not additions.
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}),
  };
  const none = (outcome: GenerateResult['outcome']): GenerateResult<T> => ({ value: null, outcome, usage });

  const parts = (body.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? []);
  // Check for a refusal and a cut-off before reading the text: neither need match the schema.
  if (parts.some((p) => p.type === 'refusal')) return none('refusal');
  if (body.status === 'incomplete') {
    const reason = body.incomplete_details?.reason;
    if (reason === 'max_output_tokens') return none('max_tokens');
    if (reason === 'content_filter') return none('refusal');
    return none('invalid');
  }

  const text = parts.map((p) => (p.type === 'output_text' ? (p.text ?? '') : '')).join('');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return none('invalid');
  }
  return matchesSchema(value, schema) ? { value: value as T, outcome: 'ok', usage } : none('invalid');
}

// ---- failures ----

/** 429s that waiting does not fix: the account has no credit left or is over a spend or usage limit. */
const BILLING_CODES = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
]);

/** `Retry-After` as whole seconds, when the provider sent a number. */
function retryAfterSeconds(res: Response): string | null {
  const raw = res.headers.get('retry-after')?.trim();
  return raw && /^\d+(\.\d+)?$/.test(raw) ? String(Math.ceil(Number(raw))) : null;
}

/**
 * Map an HTTP failure onto the route error codes, as the Anthropic adapter does. Messages stay
 * generic and never quote the provider; its own wording goes to the server log with the key removed.
 */
async function httpError(res: Response, apiKey: string): Promise<AiError> {
  let detail: { type?: unknown; code?: unknown; message?: unknown } = {};
  try {
    const body: unknown = await res.json();
    if (isPlain(body) && isPlain(body.error)) detail = body.error;
  } catch { /* not JSON: a proxy's error page */ }
  const said = typeof detail.message === 'string' ? detail.message.split(apiKey).join('[key]') : '';
  console.error('[ai] provider error', res.status, detail.type, detail.code, said);

  if (res.status === 401 || res.status === 403) {
    return new AiError('provider', 'The AI provider rejected the server credentials.');
  }
  if (res.status === 429) {
    if (BILLING_CODES.has(String(detail.code)) || BILLING_CODES.has(String(detail.type))) {
      return new AiError('provider', 'The AI provider account has no credit left or is over its spend limit.');
    }
    const retry = retryAfterSeconds(res);
    return new AiError('rate_limited', 'The AI provider is rate limiting this server. Try again shortly.',
      retry ? { headers: { 'retry-after': retry } } : {});
  }
  if (res.status === 404) return new AiError('provider', 'The AI provider does not have the configured model.');
  if (res.status >= 400 && res.status < 500) return new AiError('provider', 'The AI provider rejected the request.');
  return new AiError('provider', 'The AI provider call failed.');
}

// ---- the provider ----

export function createOpenAiProvider(opts: OpenAiProviderOptions): AiProvider {
  // summaries → bulk, the tour → tour, points of interest and details → synthesis
  const models = tierModels(opts.config.ai.openaiModels);
  const url = `${(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/responses`;
  const cacheBreakpoint = opts.cacheBreakpoint ?? true;

  return {
    id: 'openai',

    async generate<T = unknown>(req: GenerateRequest): Promise<GenerateResult<T>> {
      const doFetch = opts.fetch ?? globalThis.fetch;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(requestBody(req, models[req.role], cacheBreakpoint)),
        });
      } catch (e) {
        console.error('[ai] provider error', e instanceof Error ? e.message : e);
        throw new AiError('provider', 'Could not reach the AI provider.');
      }
      if (!res.ok) throw await httpError(res, opts.apiKey);

      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      const body: ResponseBody | null = isPlain(parsed) ? parsed : null;
      if (!body || body.status === 'failed') {
        console.error('[ai] provider error', body ? body.error?.code : 'unexpected response body');
        throw new AiError('provider', 'The AI provider call failed.');
      }
      return readReply<T>(body, req.schema);
    },

    /** The local estimate: it over-counts on purpose, and the cap it serves is far below the models' windows. */
    async countTokens(text: string): Promise<number> {
      return estimateTokens(text);
    },
  };
}
