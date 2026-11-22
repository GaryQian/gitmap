// AiProvider implementations (PLAN.md §11.1): the Anthropic adapter, a canned provider for tests and
// keyless development, and the factory that picks one from config.
import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../../config';
import type { AiProvider, GenerateRequest, GenerateResult } from '../../contracts/ai';
import { AiError } from './errors';
import { estimateTokens } from '../tokens';

export { estimateTokens };

// ---- Anthropic ----

/** Beta that enables `fallbacks: "default"`: a request the model's safety classifiers decline is
 *  re-run server-side on Anthropic's recommended substitute model instead of coming back refused. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicProviderOptions {
  apiKey: string;
  config: Config;
  /** Opt in to server-side refusal fallback (default true). Models without it ignore the setting. */
  refusalFallback?: boolean;
  /** Replaces the HTTP transport; tests use it to stay off the network. */
  fetch?: typeof globalThis.fetch;
}

export function createAnthropicProvider(opts: AnthropicProviderOptions): AiProvider {
  const client = new Anthropic({ apiKey: opts.apiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const models = opts.config.ai.models;
  const refusalFallback = opts.refusalFallback ?? true;

  return {
    id: 'anthropic',

    async generate<T = unknown>(req: GenerateRequest): Promise<GenerateResult<T>> {
      // Cache breakpoint at the end of the shared part: tools → system → cachedPrefix are cached
      // together, the varying prompt comes after it. Callers that want a hit must keep `system`,
      // `schema` and `cachedPrefix` byte-identical between calls (changing the output format
      // invalidates the prompt cache).
      const content: Anthropic.Beta.BetaTextBlockParam[] = [];
      if (req.cachedPrefix) content.push({ type: 'text', text: req.cachedPrefix, cache_control: { type: 'ephemeral' } });
      content.push({ type: 'text', text: req.prompt });

      let message: Anthropic.Beta.BetaMessage;
      try {
        // Streamed and collected: a large input with thinking can run for minutes, and a streamed
        // request does not sit on an idle connection. Thinking and effort are left at the model's
        // defaults (the current models reject attempts to disable thinking).
        message = await client.beta.messages
          .stream({
            model: models[req.role],
            max_tokens: req.maxOutputTokens,
            system: req.system,
            messages: [{ role: 'user', content }],
            output_config: { format: { type: 'json_schema', schema: req.schema } },
            ...(refusalFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
          })
          .finalMessage();
      } catch (e) {
        throw toAiError(e);
      }

      const u = message.usage;
      const cached = u.cache_read_input_tokens ?? 0;
      const usage = {
        // Total prompt size: the API reports the uncached remainder, cache writes and cache reads separately.
        inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + cached,
        outputTokens: u.output_tokens,
        cachedInputTokens: cached,
      };

      // Check the stop reason before reading content: a refusal or a truncated reply need not match the schema.
      if (message.stop_reason === 'refusal') return { value: null, outcome: 'refusal', usage };
      if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
        return { value: null, outcome: 'max_tokens', usage };
      }
      const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      try {
        return { value: JSON.parse(text) as T, outcome: 'ok', usage };
      } catch {
        return { value: null, outcome: 'invalid', usage };
      }
    },

    async countTokens(text: string): Promise<number> {
      try {
        // Counts are model-specific; the synthesis model handles the large requests the cap is for.
        const res = await client.messages.countTokens({ model: models.synthesis, messages: [{ role: 'user', content: text }] });
        return res.input_tokens;
      } catch {
        return estimateTokens(text);
      }
    },
  };
}

/** Map SDK errors onto the route error codes. Messages stay generic; details go to the server log. */
function toAiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.APIError) console.error('[ai] provider error', e.status, e.type, e.message);
  else console.error('[ai] provider error', e);

  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new AiError('provider', 'The AI provider rejected the server credentials.');
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new AiError('rate_limited', 'The AI provider is rate limiting this server. Try again shortly.');
  }
  if (e instanceof Anthropic.BadRequestError) {
    return new AiError('provider', 'The AI provider rejected the request.');
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new AiError('provider', 'Could not reach the AI provider.');
  }
  return new AiError('provider', 'The AI provider call failed.');
}

// ---- Canned ----

/** One scripted reply: a value (outcome 'ok'), or a non-ok outcome. */
export type CannedReply =
  | { value: unknown; usage?: GenerateResult['usage'] }
  | { outcome: 'refusal' | 'max_tokens' | 'invalid' };

export type CannedScript = CannedReply[] | ((req: GenerateRequest, index: number) => CannedReply);

export interface CannedProvider extends AiProvider {
  /** Every generate request received, in order. */
  readonly requests: GenerateRequest[];
  /** Every text passed to countTokens, in order. */
  readonly counted: string[];
}

/**
 * A provider that returns scripted replies and records what it was asked. A list is consumed one
 * reply per call (running out is an error, so a test notices an unexpected extra call); a function
 * computes the reply from the request. Token counts are the local estimate.
 */
export function createCannedProvider(script: CannedScript): CannedProvider {
  const requests: GenerateRequest[] = [];
  const counted: string[] = [];
  const zeroUsage = { inputTokens: 0, outputTokens: 0 };
  return {
    id: 'canned',
    requests,
    counted,
    async generate<T = unknown>(req: GenerateRequest): Promise<GenerateResult<T>> {
      const index = requests.length;
      requests.push(req);
      const reply = typeof script === 'function' ? script(req, index) : script[index];
      if (!reply) throw new Error(`canned provider: no scripted reply for call ${index + 1}`);
      if ('outcome' in reply) return { value: null, outcome: reply.outcome, usage: zeroUsage };
      return { value: reply.value as T, outcome: 'ok', usage: reply.usage ?? zeroUsage };
    },
    async countTokens(text: string): Promise<number> {
      counted.push(text);
      return estimateTokens(text);
    },
  };
}

// ---- Factory ----

export type Env = Record<string, string | undefined>;

/**
 * The provider named by `config.ai.provider`. Throws AiError('no_key') when its key is missing.
 * Keys come only from the environment (`.env.local`, or the Vercel project settings).
 */
export function getProvider(env: Env, config: Config): AiProvider {
  switch (config.ai.provider) {
    case 'anthropic': {
      const apiKey = env.ANTHROPIC_API_KEY?.trim();
      if (!apiKey) throw new AiError('no_key', 'No AI key is configured on the server (ANTHROPIC_API_KEY).');
      return createAnthropicProvider({ apiKey, config, refusalFallback: env.AI_REFUSAL_FALLBACK !== 'off' });
    }
    default:
      throw new AiError('provider', `Unknown AI provider "${config.ai.provider}" in config.json.`);
  }
}
