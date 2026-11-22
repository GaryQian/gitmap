// The SSE reader and the chat transport, against in-memory streams and a fake `fetch`. No network.
import { describe, expect, it } from 'vitest';
import { AiClientError } from '../client/errors';
import { createChatClient, encodeSse, parseToolInput, readSse } from './stream';
import type { SseMessage } from './stream';
import type { ChatEvent, ChatRequest } from './types';

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c);
      controller.close();
    },
  });
}

async function collect(chunks: (string | Uint8Array)[]): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const m of readSse(streamOf(chunks))) out.push(m);
  return out;
}

const request: ChatRequest = { context: 'overview', messages: [{ role: 'user', text: 'hello' }] };
const sseResponse = (events: ChatEvent[], tail = '') =>
  new Response(events.map(encodeSse).join('') + tail, { status: 200, headers: { 'content-type': 'text/event-stream' } });

async function drain(client: ReturnType<typeof createChatClient>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of client.stream(request)) out.push(e);
  return out;
}

describe('readSse', () => {
  it('reads events whatever the chunk boundaries are, down to one byte at a time', async () => {
    const text = 'event: greeting\ndata: {"a":"héllo ✓"}\n\n: keep-alive\n\ndata: second\r\n\r\ndata: third\r\rdata: fourth\n\n';
    const expected = [
      { event: 'greeting', data: '{"a":"héllo ✓"}' },
      { event: 'message', data: 'second' },
      { event: 'message', data: 'third' },
      { event: 'message', data: 'fourth' },
    ];
    expect(await collect([text])).toEqual(expected);
    const bytes = new TextEncoder().encode(text);
    // every byte its own chunk: splits lines, CRLF pairs and multi-byte characters
    expect(await collect([...bytes].map((b) => new Uint8Array([b])))).toEqual(expected);
    expect(await collect([bytes.slice(0, 31), bytes.slice(31, 33), bytes.slice(33)])).toEqual(expected);
  });

  it('joins the data lines of one event and drops an event the stream ends inside', async () => {
    expect(await collect(['data: line one\ndata:line two\ndata\nid: 7\nretry: 10\n\n', 'data: never finished\n']))
      .toEqual([{ event: 'message', data: 'line one\nline two\n' }]);
  });
});

describe('parseToolInput', () => {
  it('accepts a JSON object or nothing, and nothing else', () => {
    expect(parseToolInput('')).toEqual({});
    expect(parseToolInput('{"path":"src/a.ts"}')).toEqual({ path: 'src/a.ts' });
    expect(parseToolInput('{"path":')).toBeNull();
    expect(parseToolInput('["a"]')).toBeNull();
    expect(parseToolInput('"text"')).toBeNull();
  });
});

describe('chat client', () => {
  it('posts the conversation and yields the events up to done', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const events: ChatEvent[] = [
      { type: 'text', delta: 'Hi' },
      { type: 'tool_call', call: { id: 'c1', name: 'get_notes', input: {} } },
      { type: 'done', stop: 'tool_calls', usage: { inputTokens: 5, outputTokens: 2 } },
    ];
    const client = createChatClient({
      baseUrl: '/api/ai/',
      fetch: async (input, init) => {
        sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return sseResponse(events, 'data: {"type":"text","delta":"after the end"}\n\n');
      },
    });
    expect(await drain(client)).toEqual(events);
    expect(sent).toEqual([{ url: '/api/ai/chat', body: request }]);
  });

  it('turns every failure into an AiClientError with the shared codes', async () => {
    const failing = async (response: () => Response | Promise<Response>) => {
      try {
        await drain(createChatClient({ fetch: async () => response(), sleep: async () => {} }));
      } catch (err) {
        expect(err).toBeInstanceOf(AiClientError);
        return err as AiClientError;
      }
      return expect.unreachable() as never;
    };
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

    // a JSON error body before the stream starts
    const tooLarge = await failing(() => json(413, { error: { code: 'too_large', message: 'server wording' } }));
    expect(tooLarge).toMatchObject({ code: 'too_large', status: 413, detail: 'server wording' });
    const limited = await failing(() => json(429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'retry-after': '40' }));
    expect(limited).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 40 });
    // no route: a static host
    expect((await failing(() => new Response('<html>', { status: 404 }))).code).toBe('unavailable');
    expect((await failing(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))).code).toBe('unavailable');
    // an error event mid-stream, and a stream that just stops
    const mid = await failing(() => sseResponse([{ type: 'text', delta: 'Hi' }, { type: 'error', error: { code: 'refused', message: 'declined' } }]));
    expect(mid).toMatchObject({ code: 'refused', detail: 'declined' });
    expect((await failing(() => sseResponse([{ type: 'text', delta: 'Hi' }]))).code).toBe('network');
    expect((await failing(() => { throw new TypeError('fetch failed'); })).code).toBe('network');
  });

  it('waits out one short rate limit and tries again', async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = createChatClient({
      maxRetryAfterSeconds: 5,
      sleep: async (ms) => { waits.push(ms); },
      fetch: async () => (++calls === 1
        ? new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), { status: 429, headers: { 'retry-after': '2' } })
        : sseResponse([{ type: 'done', stop: 'end' }])),
    });
    expect(await drain(client)).toEqual([{ type: 'done', stop: 'end' }]);
    expect(calls).toBe(2);
    expect(waits).toEqual([2000]);
  });
});
