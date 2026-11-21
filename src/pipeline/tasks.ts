// Every pool task in the app, discovered rather than listed (each `*.task.ts` default-exports a
// TaskDef or an array). Used to build the in-process pool for Node scripts and tests; the browser
// pool's worker entry does its own discovery.
import type { TaskDef } from '../contracts/compute';

const modules = import.meta.glob<{ default: TaskDef | TaskDef[] }>('../**/*.task.ts', { eager: true });

export const allTasks: TaskDef[] = Object.keys(modules)
  .sort()
  .flatMap((k) => {
    const d = modules[k].default;
    return Array.isArray(d) ? d : d ? [d] : [];
  });
