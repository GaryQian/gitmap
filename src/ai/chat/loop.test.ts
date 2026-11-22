// The conversation loop end to end, in process: a fake `fetch` hands each request to the real
// /api/ai/chat handler, whose provider is scripted, and a fake ToolExecutor stands in for the map.
// No network, no key, and nothing read from the environment.
import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import { AiError, createCannedProvider, createMemoryLimiter, handlers, sequenceProblem } from '../server/index';
import type { ChatDeps, ChatProvider, ChatStreamRequest } from '../server/index';
import { fitHistory, runChatTurn, truncateResult } from './loop';
import type { ChatTurnEvent } from './loop';
import type { ChatEvent, ChatMessage, ChatToolCall, ToolExecutor, ToolOutcome } from './types';

type Step = ChatEvent[] | AiError | ((req: ChatStreamRequest) => AsyncIterable<ChatEvent>);

/** The real handler behind a `fetch`, with a provider that plays the script one request at a time. */
function server(steps: Step[] | ((req: ChatStreamRequest, index: number) => Step), deps: Partial<ChatDeps> = {}) {
  const requests: ChatStreamRequest[] = [];
  const provider: ChatProvider = {
    id: 'anthropic',
    async streamChat(req) {
      const index = requests.length;
      requests.push(req);
      const step = typeof steps === 'function' ? steps(req, index) : steps[index];
      if (!step) throw new Error(`scripted provider: no step for call ${index + 1}`);
      if (step instanceof AiError) throw step;
      if (typeof step === 'function') return step(req);
      return (async function* () { yield* step; })();
    },
  };
  const all: ChatDeps = { provider: createCannedProvider([]), chat: provider, config, limiter: createMemoryLimiter(), now: () => 0, ...deps };
  const fetch = (async (url, init) => handlers.chat(new Request(`http://test.local${String(url)}`, init), all)) as typeof globalThis.fetch;
  return { fetch, requests };
}

function executor(run: (call: ChatToolCall) => ToolOutcome | Promise<ToolOutcome>): ToolExecutor & { calls: ChatToolCall[] } {
  const calls: ChatToolCall[] = [];
  return { calls, execute: async (call) => { calls.push(call); return run(call); } };
}

const question: ChatMessage[] = [{ role: 'user', text: 'Where is the store?' }];
const callStep = (id: string, name = 'get_file', input: Record<string, unknown> = { path: 'src/app/store.ts' }, text = ''): ChatEvent[] => [
  ...(text ? [{ type: 'text', delta: text } as const] : []),
  { type: 'tool_call', call: { id, name, input } },
  { type: 'done', stop: 'tool_calls', usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 60 } },
];
const answer = (text: string): ChatEvent[] => [
  { type: 'text', delta: text }, { type: 'done', stop: 'end', usage: { inputTokens: 200, outputTokens: 20, cachedInputTokens: 150 } },
];
/** A turn's result must be a conversation the server accepts once the next user message is added. */
const continues = (messages: ChatMessage[]) => sequenceProblem([...messages, { role: 'user', text: 'next' }]);

describe('runChatTurn', () => {
  it('runs a tool call, sends its result back and ends on the answer', async () => {
    const { fetch, requests } = server([callStep('call_1', 'get_file', { path: 'src/app/store.ts' }, 'Let me look. '), answer('It is in src/app/store.ts.')]);
    const tools = executor(() => ({ ok: true, content: 'x'.repeat(500), action: 'Opened the file' }));
    const events: ChatTurnEvent[] = [];
    const { messages, summary } = await runChatTurn({
      messages: question, context: 'Repository: demo', executor: tools, fetch, resultChars: 200, onEvent: (e) => events.push(e),
    });

    expect(summary).toMatchObject({ reason: 'end', notice: null, error: null, steps: 2, toolCalls: 1 });
    expect(summary.text).toBe('Let me look. \n\nIt is in src/app/store.ts.');
    expect(summary.usage).toEqual({ inputTokens: 300, outputTokens: 30, cachedInputTokens: 210 });
    expect(tools.calls).toEqual([{ id: 'call_1', name: 'get_file', input: { path: 'src/app/store.ts' } }]);

    // the second request carried the assistant step and its result, cut to the budget with a marker
    expect(requests).toHaveLength(2);
    const sent = requests[1].messages;
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    const result = sent[2].role === 'tool' ? sent[2].results[0] : null;
    expect(result).toMatchObject({ callId: 'call_1', name: 'get_file', ok: true });
    expect(result!.content.length).toBeLessThanOrEqual(200);
    expect(result!.content).toContain('…cut');

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(messages.at(-1)).toEqual({ role: 'assistant', text: 'It is in src/app/store.ts.' });
    expect(continues(messages)).toBeNull();
    expect(question).toHaveLength(1); // the caller's list is not touched

    expect(events.map((e) => e.type)).toEqual(['step', 'text', 'tool_call', 'tool_result', 'step', 'text']);
    const done = events.find((e) => e.type === 'tool_result');
    expect(done).toMatchObject({ cut: true, outcome: { ok: true, action: 'Opened the file' } });
  });

  it('stops at the step limit, says so, and leaves a conversation that can go on', async () => {
    const { fetch, requests } = server((_req, i) => callStep(`call_${i}`, 'search_files', { query: 'store' }));
    const tools = executor(() => ({ ok: true, content: '[]' }));
    const { messages, summary } = await runChatTurn({ messages: question, context: '', executor: tools, fetch, maxSteps: 3 });

    expect(summary.reason).toBe('step_limit');
    expect(summary.notice).toContain('3');
    expect(summary.steps).toBe(3);
    expect(requests).toHaveLength(3);
    expect(tools.calls).toHaveLength(3); // the last step's calls were still run and answered
    expect(messages.at(-1)?.role).toBe('tool');
    expect(continues(messages)).toBeNull();
  });

  it('stops when the signal is cancelled: before a request, inside a stream, and between tools', async () => {
    // before anything is sent
    const idle = server([]);
    const already = new AbortController();
    already.abort();
    const none = await runChatTurn({ messages: question, context: '', executor: executor(() => ({ ok: true, content: '' })), fetch: idle.fetch, signal: already.signal });
    expect(none.summary).toMatchObject({ reason: 'aborted', steps: 0, error: null });
    expect(idle.requests).toHaveLength(0);

    // inside a stream: the words already written are kept
    const stop = new AbortController();
    const hanging = server([(req) => (async function* (): AsyncGenerator<ChatEvent> {
      yield { type: 'text', delta: 'The store ' };
      await new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('cancelled');
    })()]);
    const mid = await runChatTurn({
      messages: question, context: '', executor: executor(() => ({ ok: true, content: '' })), fetch: hanging.fetch, signal: stop.signal,
      onEvent: (e) => { if (e.type === 'text') stop.abort(); },
    });
    expect(mid.summary).toMatchObject({ reason: 'aborted', text: 'The store ' });
    expect(mid.messages.at(-1)).toEqual({ role: 'assistant', text: 'The store ' });
    expect(continues(mid.messages)).toBeNull();

    // between tools: the rest are answered as cancelled, and no further request is made
    const during = new AbortController();
    const two = server([[
      { type: 'tool_call', call: { id: 'call_1', name: 'get_notes', input: {} } },
      { type: 'tool_call', call: { id: 'call_2', name: 'get_view_state', input: {} } },
      { type: 'done', stop: 'tool_calls' },
    ]]);
    const tools = executor(() => { during.abort(); return { ok: true, content: 'notes' }; });
    const cut = await runChatTurn({ messages: question, context: '', executor: tools, fetch: two.fetch, signal: during.signal });
    expect(cut.summary.reason).toBe('aborted');
    expect(tools.calls).toHaveLength(1);
    expect(two.requests).toHaveLength(1);
    const last = cut.messages.at(-1);
    expect(last?.role === 'tool' && last.results.map((r) => r.ok)).toEqual([true, false]);
    expect(continues(cut.messages)).toBeNull();
  });

  it('reports failures with the shared codes and sentences, and does not run the tools of a cut-off step', async () => {
    const limited = server([], { limiter: { hit: async () => ({ allowed: false, count: 99, retryAfterMs: 30_000 }) } });
    const first = await runChatTurn({ messages: question, context: '', executor: executor(() => ({ ok: true, content: '' })), fetch: limited.fetch });
    expect(first.summary.reason).toBe('error');
    expect(first.summary.error).toEqual({ code: 'rate_limited', message: 'Too many AI requests. Try again in 30 seconds.', retryAfterSeconds: 30 });
    expect(first.messages).toEqual(question);

    // a failure inside the stream: what was written is kept, and the error has the provider's code
    const broken = server([[{ type: 'text', delta: 'Half' }, { type: 'error', error: { code: 'provider', message: 'upstream wording' } }]]);
    const second = await runChatTurn({ messages: question, context: '', executor: executor(() => ({ ok: true, content: '' })), fetch: broken.fetch });
    expect(second.summary).toMatchObject({ reason: 'error', error: { code: 'provider', message: 'The AI provider could not answer. Try again later.' } });
    expect(second.messages.at(-1)).toEqual({ role: 'assistant', text: 'Half' });

    // max_tokens with a tool call already written: the call is not run
    const truncated = server([[
      { type: 'text', delta: 'Looking' },
      { type: 'tool_call', call: { id: 'call_1', name: 'get_notes', input: {} } },
      { type: 'done', stop: 'max_tokens' },
    ]]);
    const tools = executor(() => ({ ok: true, content: '' }));
    const third = await runChatTurn({ messages: question, context: '', executor: tools, fetch: truncated.fetch });
    expect(third.summary.reason).toBe('max_tokens');
    expect(third.summary.notice).toBeTruthy();
    expect(tools.calls).toHaveLength(0);
    expect(continues(third.messages)).toBeNull();

    const refused = server([[{ type: 'done', stop: 'refusal' }]]);
    const fourth = await runChatTurn({ messages: question, context: '', executor: tools, fetch: refused.fetch });
    expect(fourth.summary).toMatchObject({ reason: 'refusal', notice: 'The AI provider declined this request.' });

    // an executor that throws, against its contract, costs one result and not the conversation
    const throwing = server([callStep('call_1'), answer('Could not read it.')]);
    const fifth = await runChatTurn({ messages: question, context: '', executor: { execute: async () => { throw new Error('bug'); } }, fetch: throwing.fetch });
    expect(fifth.summary.reason).toBe('end');
    const sent = throwing.requests[1].messages[2];
    expect(sent.role === 'tool' && sent.results[0].ok).toBe(false);
  });

  it('drops the oldest turns to stay within the budget, and says so', async () => {
    const old: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) {
      old.push(
        { role: 'user', text: `question ${i}` },
        { role: 'assistant', text: '', toolCalls: [{ id: `old_${i}`, name: 'read_file', input: { path: `src/f${i}.ts` } }] },
        { role: 'tool', results: [{ callId: `old_${i}`, name: 'read_file', ok: true, content: 'y'.repeat(3000) }] },
        { role: 'assistant', text: `answer ${i}` },
      );
    }
    const { fetch, requests } = server([answer('Here.')]);
    const events: ChatTurnEvent[] = [];
    const { messages, summary } = await runChatTurn({
      messages: [...old, ...question], context: 'overview', executor: executor(() => ({ ok: true, content: '' })), fetch,
      historyTokens: 2500, onEvent: (e) => events.push(e),
    });

    expect(summary.reason).toBe('end');
    expect(summary.trimmed.messages).toBeGreaterThan(0);
    expect(summary.trimmed.messages % 4).toBe(0); // whole turns only
    expect(events.find((e) => e.type === 'trimmed')).toMatchObject({ droppedMessages: summary.trimmed.messages, message: expect.stringContaining('left out') });
    const sent = requests[0].messages;
    expect(sent.length).toBe(old.length + 1 - summary.trimmed.messages);
    expect(sent[0]).toEqual(old[summary.trimmed.messages]); // a user message: the start of a kept turn
    expect(sent.at(-1)).toEqual(question[0]);
    expect(messages.slice(0, -1)).toEqual(sent);
  });
});

describe('fitHistory', () => {
  const turn = (i: number, size: number): ChatMessage[] => [
    { role: 'user', text: `question ${i}` },
    { role: 'assistant', text: 'Looking.', toolCalls: [{ id: `c${i}a`, name: 'read_file', input: { path: 'a.ts' } }, { id: `c${i}b`, name: 'get_notes', input: {} }] },
    { role: 'tool', results: [{ callId: `c${i}a`, name: 'read_file', ok: true, content: 'z'.repeat(size) }, { callId: `c${i}b`, name: 'get_notes', ok: true, content: 'notes' }] },
    { role: 'assistant', text: `answer ${i}` },
  ];

  it('leaves a conversation that fits alone', () => {
    const all = [...turn(0, 100), ...turn(1, 100)];
    expect(fitHistory(all, 'ctx', 10_000)).toEqual({ messages: all, droppedMessages: 0, shortenedResults: 0 });
  });

  it('never separates an assistant step from its tool results', () => {
    const all = [...turn(0, 4000), ...turn(1, 4000), ...turn(2, 4000), { role: 'user', text: 'and now?' } as ChatMessage];
    for (const budget of [200, 1500, 2600, 3900]) {
      const fit = fitHistory(all, 'ctx', budget);
      expect(fit.messages[0].role).toBe('user');
      expect(sequenceProblem(fit.messages)).toBeNull();
      expect(fit.messages.at(-1)).toEqual({ role: 'user', text: 'and now?' });
      expect(fit.droppedMessages % 4).toBe(0);
    }
    // three turns of about 1,200 estimated tokens each, and the new question
    expect(fitHistory(all, 'ctx', 2600).droppedMessages).toBe(4);
    expect(fitHistory(all, 'ctx', 1500).droppedMessages).toBe(8);
    expect(fitHistory(all, 'ctx', 200).droppedMessages).toBe(12);
  });

  it('shortens the older tool results of a single turn that is too large, keeping the newest', () => {
    const one: ChatMessage[] = [{ role: 'user', text: 'read everything' }];
    for (let i = 0; i < 4; i++) {
      one.push(
        { role: 'assistant', text: '', toolCalls: [{ id: `r${i}`, name: 'read_file', input: { path: `f${i}.ts` } }] },
        { role: 'tool', results: [{ callId: `r${i}`, name: 'read_file', ok: true, content: 'q'.repeat(4000) }] },
      );
    }
    const fit = fitHistory(one, 'ctx', 2000);
    expect(fit.droppedMessages).toBe(0);
    expect(fit.shortenedResults).toBeGreaterThan(0);
    expect(fit.messages).toHaveLength(one.length);
    expect(sequenceProblem(fit.messages)).toBeNull();
    expect(fit.messages.at(-1)).toEqual(one.at(-1)); // the results the model has not read yet
    expect(one[2]).toMatchObject({ results: [{ content: 'q'.repeat(4000) }] }); // the input is not modified
  });
});

describe('truncateResult', () => {
  it('cuts at the budget with a marker that says how much is missing', () => {
    expect(truncateResult('short', 100)).toEqual({ content: 'short', cut: false });
    const cut = truncateResult('a'.repeat(5000), 1000);
    expect(cut.cut).toBe(true);
    expect(cut.content.length).toBeLessThanOrEqual(1000);
    expect(cut.content).toMatch(/…cut: \d+ more characters/);
  });
});
