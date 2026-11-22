// The chat assistant's wire format and tool contract (PLAN.md §11.5). Browser-safe: no server imports.
//
// How a turn works. The repo exists only in the browser, so the model cannot reach it: tools are
// executed here, in the page. One user message starts a loop:
//   1. the page POSTs the conversation to /api/ai/chat and reads a stream of ChatEvents;
//   2. text deltas are shown as they arrive; tool calls are collected;
//   3. when the step ends with stop 'tool_calls', the page runs each call through a ToolExecutor,
//      appends the results as a 'tool' message, and POSTs again;
//   4. the loop ends on stop 'end' (or a limit), and the answer is whatever text has been streamed.
// The server is stateless: every request carries the whole conversation.

/** One tool invocation asked for by the model. `id` pairs it with its result. */
export interface ChatToolCall { id: string; name: string; input: Record<string, unknown> }

/** What the page sends back for one call. `content` is text or JSON text, already truncated to a budget. */
export interface ChatToolResult { callId: string; name: string; ok: boolean; content: string }

export type ChatMessage =
  | { role: 'user'; text: string }
  /** An assistant step: any text it wrote, and the tool calls it ended with (if it asked for any). */
  | { role: 'assistant'; text: string; toolCalls?: ChatToolCall[] }
  /** The results of the calls of the assistant step just before it, in the same order. */
  | { role: 'tool'; results: ChatToolResult[] };

/** POST /api/ai/chat. */
export interface ChatRequest {
  /**
   * A compact overview of the map (repo name, size, cities with their summaries, languages), built by
   * the page. Stable for a map, so providers cache it as a prompt prefix. Details come through tools.
   */
  context: string;
  messages: ChatMessage[];
}

export type ChatStop = 'end' | 'tool_calls' | 'max_tokens' | 'refusal';

/**
 * The response body of /api/ai/chat is a server-sent event stream: one `data: <ChatEvent JSON>` per
 * event, blank-line separated. A failure before the stream starts is an ordinary JSON error body
 * (AiErrorBody) with a non-2xx status; a failure mid-stream is an 'error' event followed by the end.
 */
export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ChatToolCall }
  | { type: 'done'; stop: ChatStop; usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } }
  | { type: 'error'; error: { code: string; message: string } };

/** A tool as offered to the model. The same shape as an MCP tool (`name`, `description`, `inputSchema`). */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments: an object schema with `additionalProperties: false`. */
  inputSchema: Record<string, unknown>;
  /** 'read' tools only look things up; 'act' tools change what the map shows. Neither can change the repo. */
  kind: 'read' | 'act';
}

export interface ToolOutcome {
  ok: boolean;
  /** What the model reads: text or JSON text. Keep it small; the loop truncates anything over its budget. */
  content: string;
  /** For 'act' tools: a short past-tense line for the transcript, such as "Turned on the Recency overlay". */
  action?: string;
}

/** Runs tool calls against the open map. Implemented by the app (src/app/chat); never throws. */
export interface ToolExecutor {
  execute(call: ChatToolCall, signal?: AbortSignal): Promise<ToolOutcome>;
}
