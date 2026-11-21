// Entry point of a pool worker. Started by workerPool.ts; the messages are described in protocol.ts.
import { config as defaultConfig } from '../config';
import { openRepoAccess } from '../git';
import { createWorkerState } from './context';
import { toWireError, type FromWorker, type ToWorker } from './protocol';
import { collectTasks, runTask, taskTable } from './tasks';

const scope = self as unknown as DedicatedWorkerGlobalScope;

// Every `*.task.ts` under src/ (rule 3 of src/contracts/README.md: no shared registry).
const table = taskTable(collectTasks(import.meta.glob('../**/*.task.ts', { eager: true })));

let transfers: Transferable[] = [];
const state = createWorkerState(defaultConfig, openRepoAccess, (buffers) => { transfers.push(...buffers); });

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(msg, transfer);
}

async function run(id: number, task: string, input: unknown): Promise<void> {
  transfers = [];
  let out: FromWorker;
  try {
    out = { type: 'result', id, ok: true, value: await runTask(table, task, input, state.ctx) };
  } catch (e) {
    out = { type: 'result', id, ok: false, error: toWireError(e) };
  }
  // A buffer listed twice would make postMessage throw.
  const list = out.ok ? [...new Set(transfers)] : [];
  transfers = [];
  try {
    post(out, list);
  } catch (e) {
    // The value could not be cloned or a buffer could not be transferred.
    post({ type: 'result', id, ok: false, error: toWireError(e) });
  }
}

scope.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      state.setConfig(msg.config);
      break;
    case 'setRepo':
      state.setRepo(msg.locator);
      post({ type: 'repoSet', seq: msg.seq });
      break;
    case 'run':
      void run(msg.id, msg.task, msg.input);
      break;
  }
};

post({ type: 'ready' });
