import { describe, expect, it } from 'vitest';
import { runQuery } from '../../testing/treesitter';
import { jsSyntax, tsSyntax } from './queries';

const SOURCE = `
export class View extends ui.Base implements Drawable {
  draw(ctx: Canvas): void { paint(ctx); ctx.flush(); }
}
function helper() { return new View(); }
`;

describe('TypeScript and JavaScript queries', () => {
  it('compile for each grammar and capture definitions, references and exports', async () => {
    expect(tsSyntax.grammar('src/a.ts')).toBe('typescript');
    expect(tsSyntax.grammar('src/a.tsx')).toBe('tsx');
    expect(jsSyntax.grammar('src/a.js')).toBe('tsx');
    for (const grammar of ['typescript', 'tsx']) {
      const caps = await runQuery(grammar, tsSyntax.queries[grammar], SOURCE);
      const texts = (capture: string) => caps.filter((c) => c.capture === capture).map((c) => c.text.split(/\W/)[0]);
      expect(caps.filter((c) => c.capture === 'definition.class')).toHaveLength(1);
      expect(caps.filter((c) => c.capture === 'definition.method')).toHaveLength(1);
      expect(caps.filter((c) => c.capture === 'definition.function')).toHaveLength(1);
      expect(caps.filter((c) => c.capture === 'reference.call').length).toBeGreaterThanOrEqual(2);
      expect(caps.filter((c) => c.capture === 'reference.inherit')).toHaveLength(2);
      expect(texts('qualifier').sort()).toEqual(['ctx', 'ui']);
      expect(texts('export')).toEqual(['View']);
      expect(texts('name')).toEqual(expect.arrayContaining(['View', 'draw', 'helper', 'paint', 'flush', 'Base', 'Drawable', 'Canvas']));
    }
  });

  it('reads a JSX element as a call to its component', async () => {
    const caps = await runQuery('tsx', jsSyntax.queries.tsx, 'const el = <Panel title="x"><div /><ui.Row /></Panel>;\n');
    const calls = caps.filter((c) => c.capture === 'name').map((c) => c.text);
    expect(calls).toEqual(['Panel', 'Row']);
  });
});
