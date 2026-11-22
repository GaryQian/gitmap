// The chat assistant's browser-safe surface (PLAN.md §11.5): the wire types and tool catalogue (the
// contract with src/app/chat), the map overview, the transport and the conversation loop.
// The server half is src/ai/server/chat.ts and is not exported from here.
export type {
  ChatEvent, ChatMessage, ChatRequest, ChatStop, ChatToolCall, ChatToolResult, ToolDefinition, ToolExecutor, ToolOutcome,
} from './types';
export { CHAT_TOOLS, CHAT_TOOL_NAMES, DIRECTIONS, OVERLAY_NAMES } from './tools';

export { buildChatContext } from './context';
export type { ChatContextOptions } from './context';

export { createChatClient, encodeSse, isChatEvent, parseToolInput, readSse } from './stream';
export type { ChatClient, ChatClientOptions, SseMessage } from './stream';

export { fitHistory, runChatTurn, truncateResult } from './loop';
export type { ChatTurnEnd, ChatTurnEvent, ChatTurnOptions, ChatTurnResult, ChatTurnSummary, FitResult } from './loop';

export { CHAT_TUNABLES } from './tunables';
