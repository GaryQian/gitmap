// The public, browser-safe surface of the AI module (PLAN.md §11). See README.md for what runs where.
//
// Nothing here may import ./server: that folder pulls in the provider SDK and belongs to the
// function runtime only. Server code is reached through 'src/ai/server' directly, by api/ and tests.

// ---- digest (worker or Node): the context the model sees, built from the replica and the parse facts ----
export { buildDigest, buildDigestText, buildDetailContext, digestHash, poiCount } from './digest';
export type { CityContext, DetailContext, Digest, DigestInput, DigestText, DigestTokens } from './digest';
export { CHARS_PER_TOKEN, estimateTokens } from './tokens';

// ---- provider (anywhere): which one is in use, and its three model tiers (synthesis, tour, bulk) ----
export { activeAi, resolveProviderId, tierModels } from './active';
export type { ActiveAi, AiEnv, TierModels } from './active';

// ---- client (worker, main thread or Node): the four routes, typed ----
export { createAiClient, sleep } from './client/http';
export type { AiClient, AiClientOptions, CallOptions } from './client/http';
export { AiClientError, describeAiError, toAiErrorInfo } from './client/errors';
export type { AiClientErrorCode, AiErrorInfo, AiServerErrorCode } from './client/errors';

// ---- orchestration (worker or Node): map → reduce → on demand, as ModelPatch operations ----
export { generateAnnotations, idleDetails, poiId, poisFromResponse, reduceHeadStart, stepsFromResponse, summaryId, TOUR_ID, TOUR_VERSION } from './client/generate';
export type { AiProgress, AiStage, AiStageError, GenerateOptions, GenerateResult } from './client/generate';
export { generateDetail, withheldMessage } from './client/detail';
export type { DetailOptions, DetailResult } from './client/detail';

// ---- consent (main thread): asked once per repository, remembered in this browser ----
export { aiAllowed, CONSENT_KEY, getConsent, hasStoredAnnotations, resetConsent, setConsent, shouldAsk } from './client/consent';
export type { Consent, ConsentStorage } from './client/consent';

// ---- chat assistant (main thread): the tool contract, the map overview, the transport and the loop ----
export { buildChatContext, CHAT_TOOLS, CHAT_TOOL_NAMES, CHAT_TUNABLES, createChatClient, DIRECTIONS, fitHistory, OVERLAY_NAMES, readSse, runChatTurn, truncateResult } from './chat';
export type {
  ChatClient, ChatClientOptions, ChatContextOptions, ChatEvent, ChatMessage, ChatRequest, ChatStop, ChatToolCall, ChatToolResult,
  ChatTurnEnd, ChatTurnEvent, ChatTurnOptions, ChatTurnResult, ChatTurnSummary, ToolDefinition, ToolExecutor, ToolOutcome,
} from './chat';
