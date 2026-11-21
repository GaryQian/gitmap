import { describe, expect, it } from 'vitest';
import type { FileFacts } from '../../contracts/lang';
import { createRepoIndex } from '../../shared/repoIndex';
import plugins, { includeResolver, scanIncludes } from './index';

const file = (path: string): FileFacts => ({ path, oid: '', bytes: 0, lang: path.endsWith('.c') ? 'c' : 'cpp', loc: 1, imports: [] });

describe('c-family scanner', () => {
  it('finds quoted and angle includes and skips comments and strings', () => {
    const { imports } = scanIncludes([
      `#include <stdio.h>`,
      `  #  include "engine/core.h"`,
      `// #include "line_comment.h"`,
      `/* #include "block_comment.h"`,
      `#include "still_in_block.h" */`,
      `const char *s = "// not a comment"; #include "not_at_line_start.h"`,
      `const char *t = "/* not a comment either";`,
      `#include "after_strings.h" // trailing`,
      `#define X 1`,
    ].join('\n'));
    expect(imports).toEqual([
      { spec: 'stdio.h', kind: 'include-system' },
      { spec: 'engine/core.h', kind: 'include' },
      { spec: 'after_strings.h', kind: 'include' },
    ]);
  });

  it('claims C sources as c and headers as cpp', () => {
    const [c, cpp] = plugins;
    expect(c.extensions).toContain('c');
    expect(cpp.extensions).toEqual(expect.arrayContaining(['h', 'hpp', 'cc', 'cpp']));
  });
});

describe('c-family resolver', () => {
  const index = createRepoIndex([
    'engine/render/draw.c', 'engine/render/config.h', 'engine/render/draw.h',
    'engine/audio/mix.c', 'engine/audio/config.h',
    'tools/packer/main.c', 'tools/packer/config.h',
    'include/engine/api.h',
    'third/a/types.h', 'fourth/b/types.h',
    'app/main.c',
  ].map(file));
  const resolver = includeResolver(index);
  const resolve = (from: string, spec: string, kind = 'include') => resolver.resolve(index.get(from)!, { spec, kind });

  it('prefers the file next to the including file', () => {
    expect(resolve('engine/audio/mix.c', 'config.h')).toEqual([{ path: 'engine/audio/config.h', confidence: 1 }]);
    expect(resolve('engine/audio/mix.c', '../render/draw.h')).toEqual([{ path: 'engine/render/draw.h', confidence: 1 }]);
  });

  it('matches by suffix and breaks ties by the nearest directory', () => {
    const unique = resolve('app/main.c', 'engine/api.h');
    expect(unique.map((r) => r.path)).toEqual(['include/engine/api.h']);
    // Three files end in config.h; only engine/audio/config.h shares two leading directories with engine/audio/fx.
    const withFx = createRepoIndex([...index.files, file('engine/audio/fx/echo.c')]);
    const nearest = includeResolver(withFx).resolve(withFx.get('engine/audio/fx/echo.c')!, { spec: 'config.h', kind: 'include' });
    expect(nearest.map((r) => r.path)).toEqual(['engine/audio/config.h']);
    // An angle include resolves the same way, with less confidence than a quoted one.
    const angle = includeResolver(withFx).resolve(withFx.get('engine/audio/fx/echo.c')!, { spec: 'config.h', kind: 'include-system' });
    expect(angle.map((r) => r.path)).toEqual(['engine/audio/config.h']);
    expect(angle[0].confidence).toBeLessThan(nearest[0].confidence);
  });

  it('returns one lower-confidence match when the tie-break cannot settle it, and nothing for system headers', () => {
    const settled = resolve('app/main.c', 'engine/api.h');
    const unsettled = resolve('app/main.c', 'types.h'); // third/a/types.h and fourth/b/types.h are equally far
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0].confidence).toBeLessThan(settled[0].confidence);
    expect(resolve('app/main.c', 'stdio.h', 'include-system')).toEqual([]);
    expect(resolve('app/main.c', 'vector', 'include-system')).toEqual([]);
  });
});
