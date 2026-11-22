// The conversation loop of the chat assistant (PLAN.md §11.5; the turn is described at the top of
// types.ts). One user message starts it: the conversation is POSTed, the reply is read as a stream,
// the tool calls the model ends a step with are run in the page through a ToolExecutor, their
// results are appended, and the conversation is POSTed again, until the model answers without
// asking for a tool or a limit is reached. Browser-safe; it never touches the DOM or a store.
import { config } from '../../config';
import { describeAiError, toAiErrorInfo } from '../client/errors';
import type { AiErrorInfo } from '../client/errors';
import { estimateTokens } from '../tokens';
import { createChatClient } from './stream';
import type { ChatClient } from './stream';
import { CHAT_TUNABLES } from './tunables';
import type { ChatMessage, ChatToolCall, ChatToolResult, ToolExecutor, ToolOutcome } from './types';

/** What the loop reports while a turn runs. */
export type ChatTurnEvent =
  /** A request to the model is being sent; `step` counts from 1. */
  | { type: 'step'; step: number }
  /** Words of the answer, as they arrive. Text can come before tool calls as well as at the end. */
  | { type: 'text'; delta: string }
  /** The model asked for a tool. It is run once the step has ended. */
  | { type: 'tool_call'; call: ChatToolCall }
  /** A tool has run. `outcome.content` is what the model will read; `cut` says it was shortened. */
  | { type: 'tool_result'; call: ChatToolCall; outcome: ToolOutcome; cut: boolean }
  /** Older parts of the conversation were left out to stay within the size limit. */
  | { type: 'trimmed'; droppedMessages: number; shortenedResults: number; message: string };

/**
 * Why a turn ended. 'end': the model finished its answer. 'refusal' and 'max_tokens' come from the
 * model. 'step_limit': it was still asking for tools after the last allowed step. 'aborted': the
 * signal (the Stop button). 'error': a failure, in `error`.
 */
export type ChatTurnEnd = 'end' | 'refusal' | 'max_tokens' | 'step_limit' | 'aborted' | 'error';

export interface ChatTurnSummary {
  reason: ChatTurnEnd;
  /** One sentence for the transcript when the turn did not simply end; null for 'end' and 'aborted'. */
  notice: string | null;
  /** With 'error': the same codes and sentences as the rest of the AI client. */
  error: AiErrorInfo | null;
  /** Requests answered by the model. */
  steps: number;
  /** Everything the assistant wrote in this turn, steps joined by a blank line. */
  text: string;
  /** Tool calls that were run. */
  toolCalls: number;
  /** What was left out of the conversation to keep it within the budget (zero when nothing was). */
  trimmed: { messages: number; results: number };
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
}

export interface ChatTurnResult {
  /**
   * The conversation to pass to the next turn: what was given (less anything trimmed), then this
   * turn's assistant steps and tool results. Always a valid request body once a user message is appended.
   */
  messages: ChatMessage[];
  summary: ChatTurnSummary;
}

export interface ChatTurnOptions {
  /** The conversation so far, ending with the new user message. Not modified. */
  messages: readonly ChatMessage[];
  /** The map overview (`buildChatContext`). Keep it identical between turns so it stays cached. */
  context: string;
  /** Runs the tool calls against the open map. */
  executor: ToolExecutor;
  /** The transport. Default: `createChatClient({ fetch, baseUrl })`. */
  client?: ChatClient;
  fetch?: typeof fetch;
  /** Where the routes are mounted. Default '/api/ai'. */
  baseUrl?: string;
  /** Cancels the request in flight and the tool being run (the Stop button). */
  signal?: AbortSignal;
  /** Requests to the model for this user message. Default `CHAT_TUNABLES.maxSteps`. */
  maxSteps?: number;
  /** Characters of one tool result. Default `CHAT_TUNABLES.resultChars`. */
  resultChars?: number;
  /** Estimated tokens of context plus conversation. Default `CHAT_TUNABLES.historyTokens`, capped by the server's limit. */
  historyTokens?: number;
  onEvent?: (event: ChatTurnEvent) => void;
}

// ---- tool results ----

/** Room kept for the marker when a result is cut. */
const MARKER_ROOM = 96;
const CANCELLED = 'Cancelled before this tool ran.';
/** What an old tool result is replaced by when one turn alone outgrows the budget. */
const ELIDED = '[This result was dropped to save space. Call the tool again if it is still needed.]';

/**
 * A tool result within the per-result budget. Anything over it is cut at the budget with a marker
 * that says how much is missing, so the model knows to ask for less instead of trusting a partial answer.
 */
export function truncateResult(content: string, maxChars: number): { content: string; cut: boolean } {
  if (content.length <= maxChars) return { content, cut: false };
  let keep = Math.max(0, maxChars - MARKER_ROOM);
  // not in the middle of a surrogate pair
  if (keep > 0 && content.charCodeAt(keep - 1) >= 0xd800 && content.charCodeAt(keep - 1) <= 0xdbff) keep--;
  const marker = `\n…cut: ${content.length - keep} more characters not shown. Ask for a smaller range or a lower limit.`;
  return { content: content.slice(0, keep) + marker, cut: true };
}

// ---- the history budget ----

export interface FitResult {
  messages: ChatMessage[];
  droppedMessages: number;
  shortenedResults: number;
}

const cost = (context: string, messages: readonly ChatMessage[]) => estimateTokens(context) + estimateTokens(JSON.stringify(messages));

/**
 * Keep context plus conversation within `maxTokens` (the shared estimate). Whole turns are dropped
 * from the oldest end, a turn being a user message and everything up to the next one, so an
 * assistant step is never separated from its tool results and the conversation still starts with
 * a user message. The newest turn is never dropped: if it alone is too large, its older tool
 * results are replaced by a short note, oldest first, and the newest results are left alone.
 */
export function fitHistory(messages: readonly ChatMessage[], context: string, maxTokens: number): FitResult {
  let kept = [...messages];
  let droppedMessages = 0;
  let shortenedResults = 0;
  if (cost(context, kept) <= maxTokens) return { messages: kept, droppedMessages, shortenedResults };

  for (;;) {
    const next = kept.findIndex((m, i) => i > 0 && m.role === 'user');
    if (next === -1) break; // one turn left
    droppedMessages += next;
    kept = kept.slice(next);
    if (cost(context, kept) <= maxTokens) return { messages: kept, droppedMessages, shortenedResults };
  }

  let newest = -1;
  for (let i = kept.length - 1; i >= 0 && newest === -1; i--) if (kept[i].role === 'tool') newest = i;
  for (let i = 0; i < newest; i++) {
    const m = kept[i];
    if (m.role !== 'tool') continue;
    const results: ChatToolResult[] = m.results.map((r) => {
      if (r.content.length <= ELIDED.length) return r;
      shortenedResults++;
      return { ...r, content: ELIDED };
    });
    kept[i] = { role: 'tool', results };
    if (cost(context, kept) <= maxTokens) break;
  }
  return { messages: kept, droppedMessages, shortenedResults };
}

// ---- the loop ----

function trimNotice(dropped: number, shortened: number): string {
  if (dropped > 0) return 'Earlier messages were left out to keep the conversation within the size limit.';
  return `Older tool results were left out to keep the conversation within the size limit (${shortened}).`;
}

/**
 * Run one user message to its answer. Resolves, never rejects: a failure, a cancelled signal and
 * every limit end the turn with a `summary.reason`, and `messages` is always a conversation the
 * next turn can continue from.
 */
export async function runChatTurn(options: ChatTurnOptions): Promise<ChatTurnResult> {
  const { context, executor, signal } = options;
  const client = options.client ?? createChatClient({ fetch: options.fetch, baseUrl: options.baseUrl });
  const maxSteps = Math.max(1, Math.floor(options.maxSteps ?? CHAT_TUNABLES.maxSteps));
  const resultChars = options.resultChars ?? CHAT_TUNABLES.resultChars;
  // Never above what the server accepts, whatever the tunable says; the margin covers the system prompt and the tool list.
  const historyTokens = Math.min(options.historyTokens ?? CHAT_TUNABLES.historyTokens, Math.floor(config.ai.maxInputTokens * 0.8));

  const emit = (event: ChatTurnEvent) => {
    try { options.onEvent?.(event); } catch (err) { console.error('[ai] chat event handler failed', err); }
  };

  let messages: ChatMessage[] = [...options.messages];
  const texts: string[] = [];
  const summary: ChatTurnSummary = {
    reason: 'end', notice: null, error: null, steps: 0, text: '', toolCalls: 0,
    trimmed: { messages: 0, results: 0 },
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  };
  const finish = (reason: ChatTurnEnd, notice: string | null = null, error: AiErrorInfo | null = null): ChatTurnResult => {
    summary.reason = reason;
    summary.notice = notice;
    summary.error = error;
    summary.text = texts.join('\n\n');
    return { messages, summary };
  };

  for (let step = 1; ; step++) {
    if (signal?.aborted) return finish('aborted');

    const fit = fitHistory(messages, context, historyTokens);
    if (fit.droppedMessages > 0 || fit.shortenedResults > 0) {
      messages = fit.messages;
      summary.trimmed.messages += fit.droppedMessages;
      summary.trimmed.results += fit.shortenedResults;
      emit({
        type: 'trimmed', droppedMessages: fit.droppedMessages, shortenedResults: fit.shortenedResults,
        message: trimNotice(fit.droppedMessages, fit.shortenedResults),
      });
    }

    emit({ type: 'step', step });
    let text = '';
    const calls: ChatToolCall[] = [];
    let stop: 'end' | 'tool_calls' | 'max_tokens' | 'refusal' = 'end';
    try {
      for await (const event of client.stream({ context, messages }, { signal })) {
        if (event.type === 'text') {
          text += event.delta;
          emit({ type: 'text', delta: event.delta });
        } else if (event.type === 'tool_call') {
          calls.push(event.call);
          emit({ type: 'tool_call', call: event.call });
        } else if (event.type === 'done') {
          stop = event.stop;
          if (event.usage) {
            summary.usage.inputTokens += event.usage.inputTokens;
            summary.usage.outputTokens += event.usage.outputTokens;
            summary.usage.cachedInputTokens += event.usage.cachedInputTokens ?? 0;
          }
        }
      }
    } catch (err) {
      // What was already written stays in the conversation; the calls of an unfinished step are not run.
      if (text) { messages.push({ role: 'assistant', text }); texts.push(text); }
      const info = toAiErrorInfo(err);
      return info.code === 'aborted' || signal?.aborted ? finish('aborted') : finish('error', info.message, info);
    }
    summary.steps = step;
    if (text) texts.push(text);

    // Tools are run only for a step that ended by asking for them: a step that was cut off or
    // refused may carry a call whose arguments are incomplete.
    if (stop !== 'tool_calls' || calls.length === 0) {
      if (text) messages.push({ role: 'assistant', text });
      if (stop === 'refusal') return finish('refusal', describeAiError('refused'));
      if (stop === 'max_tokens') return finish('max_tokens', 'The answer was cut off because it reached the length limit.');
      return finish('end');
    }

    messages.push({ role: 'assistant', text, toolCalls: calls });
    const results: ChatToolResult[] = [];
    for (const call of calls) {
      if (signal?.aborted) {
        // every call still gets an answer, so the conversation stays one the providers accept
        results.push({ callId: call.id, name: call.name, ok: false, content: CANCELLED });
        continue;
      }
      let outcome: ToolOutcome;
      try {
        outcome = await executor.execute(call, signal);
      } catch (err) {
        // the contract says an executor never throws; a bug there must not end the conversation
        console.error('[ai] chat tool failed', call.name, err);
        outcome = { ok: false, content: 'The tool failed unexpectedly.' };
      }
      const { content, cut } = truncateResult(String(outcome.content ?? ''), resultChars);
      const shown: ToolOutcome = { ...outcome, ok: Boolean(outcome.ok), content };
      results.push({ callId: call.id, name: call.name, ok: shown.ok, content });
      summary.toolCalls++;
      emit({ type: 'tool_result', call, outcome: shown, cut });
    }
    messages.push({ role: 'tool', results });

    if (signal?.aborted) return finish('aborted');
    if (step >= maxSteps) {
      return finish('step_limit', `Stopped after ${maxSteps} steps of looking things up. Ask again to continue from here.`);
    }
  }
}
