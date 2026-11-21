import { describe, expect, it } from 'vitest';
import type { FileFacts } from '../../contracts/lang';
import { createRepoIndex } from '../../shared/repoIndex';
import { createPythonResolver, scanPythonImports } from './index';

const file = (path: string): FileFacts => ({ path, oid: '', bytes: 0, lang: 'python', loc: 1, imports: [] });

describe('python scanner', () => {
  it('finds import and from-import statements, including parenthesised lists', () => {
    const { imports } = scanPythonImports([
      `import os.path, json as j`,
      `from a.b import c, d as e`,
      `from . import x`,
      `from ..pkg.mod import (`,
      `    first,  # a comment inside the list`,
      `    second as other,`,
      `)`,
      `from m import *`,
      `try: import fast`,
      `except ImportError:`,
      `    import slow`,
    ].join('\n'));
    expect(imports).toEqual([
      { spec: 'os.path', kind: 'import' },
      { spec: 'json', kind: 'import' },
      { spec: 'a.b', kind: 'from', names: ['c', 'd'] },
      { spec: '.', kind: 'from', names: ['x'] },
      { spec: '..pkg.mod', kind: 'from', names: ['first', 'second'] },
      { spec: 'm', kind: 'from', names: ['*'] },
      { spec: 'fast', kind: 'import' },
      { spec: 'slow', kind: 'import' },
    ]);
  });

  it('skips comments and strings, including triple-quoted ones', () => {
    const text = [
      `"""Module docstring.`,
      `import in_docstring`,
      `from also import in_docstring`,
      `"""`,
      `# import in_comment`,
      `text = "import in_string"`,
      `more = '''`,
      `from x import y`,
      `'''`,
      `value = important.thing  # not an import`,
      `import real`,
    ].join('\n');
    expect(scanPythonImports(text).imports).toEqual([{ spec: 'real', kind: 'import' }]);
  });
});

describe('python resolver', () => {
  const index = createRepoIndex([
    'setup.py',
    'src/shop/__init__.py', 'src/shop/cart.py', 'src/shop/pricing/__init__.py', 'src/shop/pricing/tax.py', 'src/shop/pricing/rules.py',
    'tools/build.py', 'tools/helpers.py',
    'tests/test_cart.py',
  ].map(file));
  const resolver = createPythonResolver(index);
  const to = (from: string, spec: string, names?: string[]) =>
    resolver.resolve(index.get(from)!, names ? { spec, kind: 'from', names } : { spec, kind: 'import' }).map((r) => r.path);

  it('resolves relative imports inside the package', () => {
    expect(to('src/shop/pricing/tax.py', '.', ['rules'])).toEqual(['src/shop/pricing/rules.py']);
    expect(to('src/shop/pricing/tax.py', '.rules', ['apply'])).toEqual(['src/shop/pricing/rules.py']);
    expect(to('src/shop/pricing/tax.py', '..cart', ['Cart'])).toEqual(['src/shop/cart.py']);
    expect(to('src/shop/pricing/tax.py', '..', ['cart'])).toEqual(['src/shop/cart.py']);
    expect(to('src/shop/pricing/tax.py', '..', ['VERSION'])).toEqual(['src/shop/__init__.py']);
    expect(to('setup.py', '...', ['x'])).toEqual([]);
  });

  it('resolves absolute imports through src/ layouts, packages and sibling scripts', () => {
    expect(to('tests/test_cart.py', 'shop.cart')).toEqual(['src/shop/cart.py']);
    expect(to('src/shop/cart.py', 'shop.pricing', ['tax', 'DEFAULT_RATE'])).toEqual(['src/shop/pricing/tax.py', 'src/shop/pricing/__init__.py']);
    expect(to('src/shop/cart.py', 'shop.pricing')).toEqual(['src/shop/pricing/__init__.py']);
    expect(to('tools/build.py', 'helpers')).toEqual(['tools/helpers.py']);
    expect(to('tools/build.py', 'os.path')).toEqual([]);
    expect(to('src/shop/cart.py', 'numpy', ['array'])).toEqual([]);
  });
});
