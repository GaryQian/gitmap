// Arguments of a tool call, checked against the tool's own input schema (src/ai/chat/tools.ts): an
// object schema whose properties are strings, integers, enums and arrays of strings. A model's
// arguments are untrusted, so nothing reaches a tool unchecked; what is wrong is said in words the
// model can act on. Harmless slips are repaired instead of refused: a null for an argument left
// out, a whole number sent as text, one string where a list of one was meant.
import type { ToolOutcome } from '../contract';

export type Args = Record<string, unknown>;
export type Checked = { ok: true; args: Args } | { ok: false; error: string };

interface Property { type?: string; enum?: readonly unknown[]; items?: { type?: string } }

const list = (names: readonly unknown[]): string => names.map((n) => JSON.stringify(n)).join(', ');

function checkValue(name: string, value: unknown, prop: Property): { value: unknown } | string {
  if (prop.enum) {
    return prop.enum.includes(value) ? { value } : `"${name}" must be one of ${list(prop.enum)}.`;
  }
  if (prop.type === 'string') {
    return typeof value === 'string' ? { value } : `"${name}" must be a string.`;
  }
  if (prop.type === 'integer') {
    const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
    return typeof n === 'number' && Number.isInteger(n) ? { value: n } : `"${name}" must be a whole number.`;
  }
  if (prop.type === 'array') {
    const items = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(items) || items.some((v) => typeof v !== 'string')) return `"${name}" must be a list of strings.`;
    return { value: items };
  }
  return { value };
}

export function validateArgs(schema: Record<string, unknown>, input: unknown): Checked {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, error: 'The arguments must be an object.' };
  const properties = (schema.properties ?? {}) as Record<string, Property>;
  const required = (schema.required ?? []) as string[];
  const known = Object.keys(properties);
  const args: Args = {};
  for (const [name, raw] of Object.entries(input)) {
    if (raw === null || raw === undefined) continue; // an argument left out
    const prop = properties[name];
    if (!prop) {
      return { ok: false, error: `Unknown argument "${name}". ${known.length ? `This tool takes: ${known.join(', ')}.` : 'This tool takes no arguments.'}` };
    }
    const checked = checkValue(name, raw, prop);
    if (typeof checked === 'string') return { ok: false, error: checked };
    args[name] = checked.value;
  }
  for (const name of required) {
    if (!(name in args) || args[name] === '') return { ok: false, error: `"${name}" is required.` };
  }
  return { ok: true, args };
}

// ---- outcomes ----

/** A result the model reads as JSON: compact, with short keys. */
export function ok(value: unknown, action?: string): ToolOutcome {
  return action === undefined ? { ok: true, content: JSON.stringify(value) } : { ok: true, content: JSON.stringify(value), action };
}

/** What was wrong, and (when there is something to offer) what would have been right. */
export function fail(error: string, more: Record<string, unknown> = {}): ToolOutcome {
  return { ok: false, content: JSON.stringify({ error, ...more }) };
}

/** A limit argument, kept between 1 and `max`. */
export function limitOf(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : fallback;
  return Math.min(max, Math.max(1, n));
}
