import { describe, expect, it } from 'vitest';
import { mentionCandidates, planShow, referencedFiles, showLine, type ShowFacts } from './autoshow';

const KNOWN = new Set(['src/app/store.ts', 'src/app/session.ts', 'src/render/camera.ts', 'README.md']);
const resolve = (text: string): string | null => (KNOWN.has(text) ? text : null);

const facts = (answer: string, more: Partial<ShowFacts> = {}): ShowFacts => ({ reason: 'end', answer, tools: [], userMoved: false, resolve, ...more });

describe('the files an answer references', () => {
  it('are its inline code and its links, in order of first mention, each once', () => {
    const answer = [
      'State lives in `src/app/store.ts`; the wiring is in [the session](src/app/session.ts#L10).',
      'See `src/app/store.ts` again, [`README.md`](https://example.com/x), and `useApp` (not a file).',
    ].join('\n\n');
    expect(mentionCandidates(answer)).toEqual(['src/app/store.ts', 'the session', 'src/app/session.ts', 'src/app/store.ts', 'README.md', 'useApp']);
    expect(referencedFiles(answer, resolve)).toEqual(['src/app/store.ts', 'src/app/session.ts', 'README.md']);
  });

  it('do not include paths in fenced code or in plain prose', () => {
    const answer = 'The camera is in src/render/camera.ts.\n\n```ts\nimport x from `src/app/store.ts`;\n```\n\nNothing else.';
    expect(referencedFiles(answer, resolve)).toEqual([]);
    expect(referencedFiles('Unclosed fence:\n\n```\n`src/app/store.ts`', resolve)).toEqual([]);
  });
});

describe('what the map shows after an answer', () => {
  it('is the one file, several files, or nothing', () => {
    expect(planShow(facts('Look at `src/app/store.ts`.'))).toEqual({ kind: 'one', path: 'src/app/store.ts' });
    expect(planShow(facts('`src/app/store.ts` and `src/render/camera.ts`'))).toEqual({ kind: 'many', paths: ['src/app/store.ts', 'src/render/camera.ts'], more: 0 });
    expect(planShow(facts('It is a map of a codebase.'))).toEqual({ kind: 'none', why: 'no-files' });
  });

  it('caps a long list at the first mentioned', () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
    const plan = planShow(facts(many.map((p) => `- \`${p}\``).join('\n'), { resolve: (t) => (many.includes(t) ? t : null) }));
    expect(plan).toEqual({ kind: 'many', paths: many.slice(0, 12), more: 18 });
    expect(planShow(facts('`src/app/store.ts` `README.md` `src/app/session.ts`', { cap: 2 }))).toMatchObject({ paths: ['src/app/store.ts', 'README.md'], more: 1 });
  });

  it('is left alone when the assistant already pointed at something', () => {
    const answer = 'Look at `src/app/store.ts`.';
    for (const name of ['select', 'focus_on', 'open_file']) {
      expect(planShow(facts(answer, { tools: [{ name: 'get_file', ok: true }, { name, ok: true }] }))).toEqual({ kind: 'none', why: 'assistant-pointed' });
    }
    // a call that failed chose nothing, and neither did a look-up or an overlay
    expect(planShow(facts(answer, { tools: [{ name: 'select', ok: false }, { name: 'read_file', ok: true }, { name: 'set_overlay', ok: true }] })).kind).toBe('one');
  });

  it('is left alone for a turn that was stopped or failed, and when the user moved the view', () => {
    const answer = 'Look at `src/app/store.ts`.';
    for (const reason of ['aborted', 'error', 'refusal', 'max_tokens', 'step_limit'] as const) {
      expect(planShow(facts(answer, { reason }))).toEqual({ kind: 'none', why: 'not-finished' });
    }
    expect(planShow(facts(answer, { userMoved: true }))).toEqual({ kind: 'none', why: 'user-moved' });
  });

  it('says what it showed in one line', () => {
    expect(showLine(1, 'src/app/store.ts', null)).toBe('Showing src/app/store.ts');
    expect(showLine(5, 'src/app/store.ts', 'Rendering')).toBe('Showing 5 files in Rendering');
    expect(showLine(3, 'src/app/store.ts', null)).toBe('Showing 3 files');
  });
});
