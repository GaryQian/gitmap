// AI server (PLAN.md §11): the four /api/ai/* handlers and the providers behind them.
// Server-only: nothing here may be imported by the browser bundle.
//
// Mounting: `handlers[name](request, deps)` takes a Web Request and returns a Web Response.
// `createDeps(process.env)` builds the dependencies once per process. For keyless local development,
// swap in a scripted provider: `{ ...createDeps(env), provider: createCannedProvider(script) }`.
import { config as defaultConfig } from '../../config';
import type { Config } from '../../config';
import { chat, getChatProvider } from './chat';
import type { ChatDeps } from './chat';
import { AiError } from './errors';
import { handlers as routeHandlers } from './handlers';
import type { Handler, RouteName } from './handlers';
import { createMemoryLimiter } from './limiter';
import { getProvider } from './provider';
import type { Env } from './provider';

export { LIMITS } from './handlers';
export type { Deps, Handler, RouteName } from './handlers';
/** Every /api/ai/* route by name: the four JSON routes, and `chat`, which answers with an event stream (chat.ts). */
export const handlers: Record<RouteName | 'chat', Handler> = { ...routeHandlers, chat };
export { chat, chatModel, chatRequest, getChatProvider, sequenceProblem, CHAT_LIMITS } from './chat';
export type { ChatDeps, ChatProvider, ChatStreamRequest, ChatUsage } from './chat';
export { anthropicMessages, createAnthropicChat } from './chatAnthropic';
export type { AnthropicChatOptions } from './chatAnthropic';
export { createOpenAiChat, openAiChatBody, openAiInput } from './chatOpenai';
export type { OpenAiChatOptions } from './chatOpenai';
export { CHAT_SYSTEM, contextBlock } from './chatPrompt';
export { AiError } from './errors';
export type { AiErrorCode } from './errors';
export { statesLinkCount, withoutLinkCounts } from './prose';
export type { ProseCheck } from './prose';
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
export function createDeps(env: Env, config: Config = defaultConfig): ChatDeps {
  let provider: ChatDeps['provider'];
  try {
    provider = getProvider(env, config);
  } catch (e) {
    provider = e instanceof AiError ? e : new AiError('provider', 'The AI provider could not be set up.');
  }
  // The chat route streams, so it has its own adapter of the same provider, chosen the same way.
  let chatProvider: ChatDeps['chat'];
  try {
    chatProvider = getChatProvider(env, config);
  } catch (e) {
    chatProvider = e instanceof AiError ? e : new AiError('provider', 'The AI provider could not be set up.');
  }
  return {
    provider,
    chat: chatProvider,
    onChatUsage: (usage) => {
      console.info(`[ai] chat input=${usage.inputTokens} cached=${usage.cachedInputTokens ?? 0} output=${usage.outputTokens}`);
    },
    config,
    limiter: createMemoryLimiter(),
    now: Date.now,
    onUsage: (route, usage) => {
      console.info(`[ai] ${route} input=${usage.inputTokens} cached=${usage.cachedInputTokens ?? 0} output=${usage.outputTokens}`);
    },
  };
}
