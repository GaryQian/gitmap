import { describe, expect, it } from 'vitest';
import type { FileFacts } from '../../contracts/lang';
import { createRepoIndex } from '../../shared/repoIndex';
import plugins, { includeResolver, isObjcHeader, scanIncludes } from './index';

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

describe('Objective-C headers in the C++ plug-in', () => {
  const [, cpp] = plugins;
  const objcHeader = [
    `#import <UIKit/UIKit.h>`,
    `#import "TrackStore.h"`,
    `@import NetKit;`,
    ``,
    `@class Track;`,
    `@protocol Forward;`,
    ``,
    `@protocol PlayerDelegate <NSObject>`,
    `- (void)playerDidFinish:(Track *)track;`,
    `@end`,
    ``,
    `/// Shows the selected track.`,
    `@interface PlayerViewController : UIViewController <TrackStoreDelegate>`,
    `@property (nonatomic, weak) id<PlayerDelegate> delegate;`,
    `- (void)selectTrack:(Track *)track;`,
    `@end`,
  ].join('\n');
  const cppHeader = [
    `#pragma once`,
    `#include <vector>`,
    `#include "engine/core.h"`,
    `/**`,
    `@class Mixer`,
    `@interface the doc tool's command, not Objective-C`,
    `*/`,
    `namespace audio { class Mixer : public Node { public: void mix(); }; }`,
    `const char *mail = "x@interface.example";`,
  ].join('\n');

  it('scans an Objective-C header as Objective-C: imports, and class and protocol names', () => {
    expect(cpp.scan(objcHeader, 'App/PlayerViewController.h')).toEqual({
      imports: [
        { spec: 'UIKit/UIKit.h', kind: 'include-system' },
        { spec: 'TrackStore.h', kind: 'include' },
        { spec: 'NetKit', kind: 'module' },
      ],
      decls: { classes: ['PlayerDelegate', 'PlayerViewController'] },
    });
    // A header of forward declarations only is still Objective-C; it just declares nothing.
    expect(cpp.scan('#import "A.h"\n@class A;\n', 'B.h')).toEqual({ imports: [{ spec: 'A.h', kind: 'include' }] });
  });

  it('leaves C and C++ headers, and every other extension, as they were', () => {
    expect(isObjcHeader(cppHeader, 'audio/mixer.h')).toBe(false);
    expect(cpp.scan(cppHeader, 'audio/mixer.h')).toEqual(scanIncludes(cppHeader));
    expect(cpp.scan(cppHeader, 'audio/mixer.h').imports.map((i) => i.spec)).toEqual(['vector', 'engine/core.h']);
    expect(cpp.scan(objcHeader, 'App/Player.hpp').decls).toBeUndefined(); // only .h can be an Objective-C header
    expect(cpp.syntax!.grammar('audio/mixer.h')).toBe('cpp');
  });

  it('reads the symbols of an Objective-C header with the Objective-C extractor', () => {
    const { defs, refs } = cpp.extractSymbols!(objcHeader, 'App/PlayerViewController.h');
    expect(defs.map((d) => `${d.kind} ${d.name}`)).toEqual(['interface PlayerDelegate', 'class PlayerViewController']);
    expect(defs[1].doc).toBe('Shows the selected track.');
    expect(refs.filter((r) => r.kind === 'inherit').map((r) => r.name)).toEqual(['NSObject', 'UIViewController', 'TrackStoreDelegate']);
    expect(refs.some((r) => r.kind === 'type' && r.name === 'Track')).toBe(true);
    // C++ has no such fallback: the runner reports the throw as a skipped file and caches nothing.
    expect(() => cpp.extractSymbols!(cppHeader, 'audio/mixer.h')).toThrow();
    // The routing the slow-pass runner can use once it passes the text to grammar(): '' means "use extractSymbols".
    const grammar = cpp.syntax!.grammar as (path: string, text?: string) => string | null;
    expect(grammar('App/PlayerViewController.h', objcHeader)).toBe('');
    expect(grammar('audio/mixer.h', cppHeader)).toBe('cpp');
  });

  it('resolves the imports of such a header, @import included', () => {
    const header: FileFacts = { ...file('App/PlayerViewController.h'), ...cpp.scan(objcHeader, 'App/PlayerViewController.h') };
    const index = createRepoIndex([header, file('Core/Store/TrackStore.h'), file('Vendor/NetKit/NetKit.h'), file('App/main.cpp')]);
    const resolver = cpp.createResolver!(index);
    const targets = header.imports.map((imp) => resolver.resolve(header, imp).map((r) => r.path));
    expect(targets).toEqual([[], ['Core/Store/TrackStore.h'], ['Vendor/NetKit/NetKit.h']]);
    expect(resolver.resolve(index.get('App/main.cpp')!, { spec: 'TrackStore.h', kind: 'include' }).map((r) => r.path)).toEqual(['Core/Store/TrackStore.h']);
  });
});
