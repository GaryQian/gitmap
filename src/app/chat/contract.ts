// The chat contract as this folder sees it: the wire types, the tool catalogue and the conversation
// loop owned by src/ai. Everything else here imports them from this file, so there is one place to
// change if they move.
export type {
  ChatClient, ChatEvent, ChatMessage, ChatRequest, ChatStop, ChatToolCall, ChatToolResult, ChatTurnEnd, ChatTurnEvent,
  ChatTurnResult, ToolDefinition, ToolExecutor, ToolOutcome,
} from '../../ai';
export { AiClientError, CHAT_TOOLS, CHAT_TOOL_NAMES, DIRECTIONS, OVERLAY_NAMES, buildChatContext, runChatTurn, toAiErrorInfo } from '../../ai';
