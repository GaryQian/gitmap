import { describe, expect, it } from 'vitest';
import { runQuery } from '../../testing/treesitter';
import { pythonSyntax } from './queries';

const SOURCE = `
LIMIT = 3

class Store(base.Model):
    """Keeps rows."""
    def add(self, row: Row) -> None:
        self.rows.append(clean(row))

def _load():
    return Store()
`;

describe('Python query', () => {
  it('compiles and captures definitions, the docstring and references', async () => {
    const caps = await runQuery(pythonSyntax.grammar('a.py')!, pythonSyntax.queries.python, SOURCE);
    const of = (capture: string) => caps.filter((c) => c.capture === capture).map((c) => c.text.split('\n')[0]);
    expect(of('definition.class')).toHaveLength(1);
    expect(of('definition.method')).toHaveLength(1);
    expect(of('definition.constant')).toEqual(['LIMIT = 3']);
    expect(of('doc')).toEqual(['"""Keeps rows."""']);
    expect(of('reference.inherit')).toHaveLength(1);
    expect(of('reference.type')).toEqual(['Row']);
    expect(of('qualifier')).toEqual(['base']);
    expect(of('name')).toEqual(expect.arrayContaining(['Store', 'add', '_load', 'append', 'clean', 'Model']));
    expect(pythonSyntax.exported!('_load', 'function')).toBe(false);
    expect(pythonSyntax.exported!('__init__', 'method')).toBe(true);
    expect(pythonSyntax.exported!('Store', 'class')).toBe(true);
  });
});
