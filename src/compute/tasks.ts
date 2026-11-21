// Turning discovered `*.task.ts` modules into a task table.
import type { TaskDef } from '../contracts/compute';

function isTaskDef(v: unknown): v is TaskDef {
  return typeof v === 'object' && v !== null
    && typeof (v as TaskDef).type === 'string' && typeof (v as TaskDef).run === 'function';
}

/**
 * The tasks in the result of `import.meta.glob('<pattern>/*.task.ts', { eager: true })`. Each module
 * default-exports a TaskDef or an array of them. The first definition of a type wins.
 */
export function collectTasks(modules: Record<string, unknown>): TaskDef[] {
  const out: TaskDef[] = [];
  const seen = new Set<string>();
  for (const [path, mod] of Object.entries(modules)) {
    const exported = (mod as { default?: unknown } | null)?.default;
    for (const def of Array.isArray(exported) ? exported : [exported]) {
      if (!isTaskDef(def)) { console.warn(`[compute] ${path}: the default export is not a TaskDef`); continue; }
      if (seen.has(def.type)) { console.warn(`[compute] ${path}: task type "${def.type}" is already defined; ignored`); continue; }
      seen.add(def.type);
      out.push(def);
    }
  }
  return out;
}

export function taskTable(tasks: TaskDef[]): Map<string, TaskDef> {
  const table = new Map<string, TaskDef>();
  for (const t of tasks) if (!table.has(t.type)) table.set(t.type, t);
  return table;
}

/** Run one task by name. An unknown type is an ordinary task failure. */
export async function runTask(table: Map<string, TaskDef>, type: string, input: unknown, ctx: Parameters<TaskDef['run']>[1]): Promise<unknown> {
  const def = table.get(type);
  if (!def) throw new Error(`unknown task type: ${type}`);
  return def.run(input, ctx);
}
