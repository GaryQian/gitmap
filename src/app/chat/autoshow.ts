// When an answer names files and the assistant did not point at anything itself, the map shows
// them: the client's guarantee that "it found something" is always visible, whether or not the
// model thought to call a tool. This is the pure part: which files an answer references, and
// whether and what to show. state.ts carries the plan out and writes the line in the transcript.
import type { ChatTurnEnd } from './contract';
import { linkTarget } from './paths';

/** The tools by which the assistant chooses what the user looks at. One of them succeeding means it has chosen. */
export const POINTING_TOOLS: ReadonlySet<string> = new Set(['select', 'focus_on', 'open_file']);

/** At most this many files are selected for one answer, the first mentioned. */
export const SHOW_CAP = 12;

/**
 * The pieces of an answer that could name a file, in the order they are written: the text of each
 * inline code span, and the text and the relative target of each link. Fenced code is skipped: a
 * path inside an example is not the answer pointing at a file. The same reading as the path buttons
 * in the rendered answer (paths.ts), made from the markdown source so it needs no DOM.
 */
export function mentionCandidates(markdown: string): string[] {
  const prose = markdown.replace(/^([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/gm, '\n');
  const out: string[] = [];
  const pieces = /(`+)([^`\n](?:[^\n]*?[^`\n])?)\1(?!`)|\[([^\]\n]+)\]\(([^)\s]*)[^)\n]*\)/g;
  for (const match of prose.matchAll(pieces)) {
    if (match[2] !== undefined) { out.push(match[2].trim()); continue; }
    out.push(match[3]!.replace(/`/g, '').trim());
    const target = linkTarget(match[4] ?? '');
    if (target !== '') out.push(target);
  }
  return out;
}

/** The files on the map an answer references, each once, in order of first mention. */
export function referencedFiles(markdown: string, resolve: (text: string) => string | null): string[] {
  const seen = new Set<string>();
  for (const candidate of mentionCandidates(markdown)) {
    const path = resolve(candidate);
    if (path !== null) seen.add(path);
  }
  return [...seen];
}

export type ShowPlan =
  | { kind: 'none'; why: 'not-finished' | 'assistant-pointed' | 'user-moved' | 'no-files' }
  | { kind: 'one'; path: string }
  /** `paths` is what to select (at most `cap`); `more` counts the referenced files left out. */
  | { kind: 'many'; paths: string[]; more: number };

export interface ShowFacts {
  /** How the turn ended. Only an answer that simply finished is acted on. */
  reason: ChatTurnEnd;
  /** Everything the assistant wrote in the turn. */
  answer: string;
  /** The tools that ran in the turn, and whether each succeeded. */
  tools: readonly { name: string; ok: boolean }[];
  /** The user moved the camera or changed the selection after asking. When in doubt, true. */
  userMoved: boolean;
  resolve: (text: string) => string | null;
  cap?: number;
}

/**
 * What to show once a turn is over. Nothing when the turn was stopped or failed, when the assistant
 * already chose what to show, when the user has taken the view somewhere themselves, or when the
 * answer names no file on the map.
 */
export function planShow(facts: ShowFacts): ShowPlan {
  if (facts.reason !== 'end') return { kind: 'none', why: 'not-finished' };
  if (facts.tools.some((t) => t.ok && POINTING_TOOLS.has(t.name))) return { kind: 'none', why: 'assistant-pointed' };
  if (facts.userMoved) return { kind: 'none', why: 'user-moved' };
  const files = referencedFiles(facts.answer, facts.resolve);
  if (files.length === 0) return { kind: 'none', why: 'no-files' };
  if (files.length === 1) return { kind: 'one', path: files[0]! };
  const cap = Math.max(1, facts.cap ?? SHOW_CAP);
  return { kind: 'many', paths: files.slice(0, cap), more: Math.max(0, files.length - cap) };
}

/** The line for the transcript: "Showing src/app/store.ts", "Showing 5 files in Rendering". */
export function showLine(count: number, onePath: string, areaLabel: string | null): string {
  if (count === 1) return `Showing ${onePath}`;
  return `Showing ${count.toLocaleString('en-US')} files${areaLabel ? ` in ${areaLabel}` : ''}`;
}
