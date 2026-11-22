// A ChatClient that plays a script instead of calling the server: for looking at the panel, for
// browser checks and for tests. It stands where the transport does, so the real conversation loop,
// the real tool executor and the real transcript run around it, and no request leaves the page.
import { AiClientError, type ChatClient, type ChatEvent, type ChatRequest, type ChatStop } from './contract';

/** One answer of the "model": words, then perhaps tool calls, or a failure. */
export interface ScriptedStep {
  /** Streamed a few characters at a time. */
  text?: string;
  /** Tools to ask for at the end of the step; the step then stops with 'tool_calls'. */
  calls?: { name: string; input?: Record<string, unknown> }[];
  /** Fail the step with this error code (after any text), as the server or the network would. */
  error?: string;
  /** How the step ends when it asks for no tool. Default 'end'. */
  stop?: ChatStop;
  /** Never finish: the step waits until it is aborted (for the Stop button). */
  hang?: boolean;
}

export interface ScriptedOptions {
  /** Characters per chunk and the pause between chunks. */
  chunk?: number;
  delayMs?: number;
}

export type Script = ScriptedStep[] | ((request: ChatRequest, step: number) => ScriptedStep);

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new AiClientError('aborted')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new AiClientError('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Each request to the "model" plays the next step of the script; a script that has run out answers
 * with a plain sentence. `requests` records what the loop sent, for assertions.
 */
export function createScriptedClient(script: Script, options: ScriptedOptions = {}): ChatClient & { requests: ChatRequest[] } {
  const chunk = Math.max(1, options.chunk ?? 6);
  const delayMs = options.delayMs ?? 12;
  const requests: ChatRequest[] = [];
  let calls = 0;

  async function* stream(request: ChatRequest, opts?: { signal?: AbortSignal }): AsyncGenerator<ChatEvent, void, void> {
    const signal = opts?.signal;
    const at = requests.length;
    requests.push(JSON.parse(JSON.stringify(request)) as ChatRequest);
    const step: ScriptedStep = typeof script === 'function' ? script(request, at) : script[at] ?? { text: 'That is all this script has to say.' };

    const text = step.text ?? '';
    for (let i = 0; i < text.length; i += chunk) {
      await pause(delayMs, signal);
      yield { type: 'text', delta: text.slice(i, i + chunk) };
    }
    if (step.hang) await pause(24 * 60 * 60 * 1000, signal);
    await pause(delayMs, signal);
    if (step.error) throw new AiClientError(step.error as ConstructorParameters<typeof AiClientError>[0]);
    for (const call of step.calls ?? []) {
      yield { type: 'tool_call', call: { id: `call-${++calls}`, name: call.name, input: call.input ?? {} } };
    }
    yield { type: 'done', stop: step.calls?.length ? 'tool_calls' : step.stop ?? 'end' };
  }

  return { stream, requests };
}
