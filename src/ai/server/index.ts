// AI server (PLAN.md §11): the four /api/ai/* handlers and the providers behind them.
// Server-only: nothing here may be imported by the browser bundle.
//
// Mounting: `handlers[name](request, deps)` takes a Web Request and returns a Web Response.
// `createDeps(process.env)` builds the dependencies once per process. For keyless local development,
// swap in a scripted provider: `{ ...createDeps(env), provider: createCannedProvider(script) }`.
import { config as defaultConfig } from '../../config';
import type { Config } from '../../config';
import { AiError } from './errors';
import type { Deps } from './handlers';
import { createMemoryLimiter } from './limiter';
import { getProvider } from './provider';
import type { Env } from './provider';

export { handlers, LIMITS } from './handlers';
export type { Deps, Handler, RouteName } from './handlers';
export { AiError } from './errors';
export type { AiErrorCode } from './errors';
export { clientIp, createMemoryLimiter } from './limiter';
export type { Limiter, LimitResult } from './limiter';
export { createAnthropicProvider, createCannedProvider, estimateTokens, getProvider, resolveProviderId } from './provider';
export type { AnthropicProviderOptions, CannedProvider, CannedReply, CannedScript, Env } from './provider';
export { createOpenAiProvider, matchesSchema, strictSchemaIssues } from './openai';
export type { OpenAiProviderOptions } from './openai';

/**
 * Dependencies for the handlers, from the environment. Never throws: a missing key or an unknown
 * provider is kept as the error the handlers will answer with, so `ai.enabled: false` and a missing
 * key are both reported per request instead of crashing the function at load.
 */
export function createDeps(env: Env, config: Config = defaultConfig): Deps {
  let provider: Deps['provider'];
  try {
    provider = getProvider(env, config);
  } catch (e) {
    provider = e instanceof AiError ? e : new AiError('provider', 'The AI provider could not be set up.');
  }
  return {
    provider,
    config,
    limiter: createMemoryLimiter(),
    now: Date.now,
    onUsage: (route, usage) => {
      console.info(`[ai] ${route} input=${usage.inputTokens} cached=${usage.cachedInputTokens ?? 0} output=${usage.outputTokens}`);
    },
  };
}
