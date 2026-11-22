import { describe, expect, it } from 'vitest';
import type { FileFacts, LanguagePlugin, Resolver, SymbolRef } from '../../contracts/lang';
import { extname } from '../../shared';
import { createRepoIndex } from '../../shared/repoIndex';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import cfamily from '../cfamily';
import objc, { extractObjcSymbols, scanObjc } from './index';

interface Expected {
  imports: [string, string][];
  notImports: [string, string][];
  calls: [string, string, string][];
}

// The registry-independent route: this plug-in for .m/.mm, the C-family plug-ins for headers and C++.
const family: LanguagePlugin[] = [objc, ...cfamily];
const pluginFor = (path: string) => family.find((p) => p.extensions.includes(extname(path)));
const facts = (path: string, text = '', excerpt?: string): FileFacts => {
  const plugin = pluginFor(path);
  return { path, oid: '', bytes: text.length, lang: plugin?.id ?? null, loc: 1, imports: [], ...plugin?.scan(text, path), ...(excerpt ? { excerpt } : {}) };
};
const isObjc = (path: string) => /\.mm?$/.test(path);
const ref = (refs: SymbolRef[], name: string, kind: string, qualifier?: string) =>
  refs.find((r) => r.name === name && r.kind === kind && r.qualifier === qualifier);

describe('objc fixture', () => {
  const files = fixtureFiles('objc');
  const expected = fixtureExpected<Expected>('objc');
  const index = createRepoIndex(Object.entries(files).map(([path, text]) => facts(path, text)));
  const resolvers = new Map<string, Resolver>(family.map((p) => [p.id, p.createResolver!(index)]));
  const edges = new Set<string>();
  const unresolved = new Set<string>();
  for (const file of index.files) {
    for (const imp of file.imports) {
      const targets = resolvers.get(file.lang!)!.resolve(file, imp);
      if (targets.length === 0) unresolved.add(imp.spec);
      for (const t of targets) edges.add(`${file.path} -> ${t.path}`);
    }
  }

  it('resolves every expected import and nothing else', () => {
    expect([...edges].sort()).toEqual(expected.imports.map(([src, dst]) => `${src} -> ${dst}`).sort());
    for (const [src, dst] of expected.notImports) expect(edges.has(`${src} -> ${dst}`), `${src} -> ${dst}`).toBe(false);
    // System frameworks stay unresolved, by #import and by @import.
    expect(unresolved).toContain('Foundation/Foundation.h');
    expect(unresolved).toContain('UIKit/UIKit.h');
    expect(unresolved).toContain('UIKit');
    expect(unresolved).not.toContain('NetKit');
  });

  it('finds the definitions and the references behind every expected call', () => {
    const symbols = new Map(Object.keys(files).filter(isObjc).map((path) => [path, objc.extractSymbols!(files[path], path)]));
    for (const [src, dst, symbol] of expected.calls) {
      expect(symbols.get(src)!.refs.some((r) => r.kind === 'call' && r.name === symbol), `${src} calls ${symbol}`).toBe(true);
      // PeakAnalyzer.hpp belongs to the C++ plug-in's slow pass.
      if (isObjc(dst)) expect(symbols.get(dst)!.defs.some((d) => d.name === symbol), `${dst} defines ${symbol}`).toBe(true);
    }

    const track = symbols.get('Core/Models/Track.m')!;
    expect(track.defs.map((d) => [d.kind, d.name, d.container])).toEqual([
      ['function', 'ClampDuration', undefined],
      ['class', 'Track', undefined],
      ['method', 'initWithTitle', 'Track'],
      ['method', 'trackWithDictionary', 'Track'],
      ['method', 'isLongerThan', 'Track'],
      ['method', 'copyWithZone', 'Track'],
    ]);
    expect(track.defs[0].exported).toBe(false);
    expect(track.defs[2].signature).toBe('- (instancetype)initWithTitle:(NSString *)title duration:(NSTimeInterval)duration');
    expect(track.defs[2].line).toBe(10);
    expect(ref(track.refs, 'initWithTitle', 'call', 'Track')?.count).toBe(1); // [[Track alloc] initWithTitle:…]
    expect(track.refs.some((r) => r.name === 'init')).toBe(false);            // [super init]: the superclass is not named here
    expect(ref(track.refs, 'title', 'call')).toBeUndefined();                 // dictionary[@"title"] is a subscript

    // A category implementation defines its methods on the class and refers to the class.
    const category = symbols.get('Core/Models/Track+Formatting.m')!;
    expect(category.defs.map((d) => [d.kind, d.name, d.container])).toEqual([
      ['method', 'formattedDuration', 'Track'],
      ['method', 'displayTitle', 'Track'],
    ]);
    expect(ref(category.refs, 'Track', 'reference')).toBeDefined();

    const store = symbols.get('Core/Store/TrackStore.m')!;
    expect(ref(store.refs, 'trackWithDictionary', 'call', 'Track')?.count).toBe(1);
    expect(ref(store.refs, 'Track', 'type')).toBeDefined();
    expect(ref(store.refs, 'trackStore', 'reference')).toBeDefined(); // @selector(trackStore:didFailWithError:)
    expect(ref(store.refs, 'alloc', 'call', 'TrackStore')).toBeUndefined();

    // Comments and strings hold no references: "[player] …" and the comment naming [track displayTitle].
    const player = symbols.get('App/PlayerViewController.m')!;
    expect(ref(player.refs, 'displayTitle', 'call')?.count).toBe(1);
    expect(player.refs.some((r) => r.name === 'player')).toBe(false);
    expect(player.refs.some((r) => r.name === 'viewDidLoad')).toBe(false); // [super viewDidLoad]
    expect(player.defs.find((d) => d.name === 'selectTrack')?.doc).toBe('Puts a track on screen and logs how many peaks its waveform has.');

    // Objective-C++: C++ calls and a function in an anonymous namespace.
    const renderer = symbols.get('Core/Audio/WaveformRenderer.mm')!;
    expect(renderer.defs.find((d) => d.name === 'SamplesForTrack')).toMatchObject({ kind: 'function', exported: false });
    expect(ref(renderer.refs, 'normalizePeaks', 'call', 'audio')).toBeDefined();
    expect(ref(renderer.refs, 'samples', 'call')).toBeUndefined(); // `std::vector<float> samples(...)` declares
  });
});

describe('objc scanner', () => {
  it('reads #import, #include and @import, and leaves @class alone', () => {
    const scan = scanObjc([
      `#import <Foundation/Foundation.h>`,
      `#import "Track.h"`,
      `#include "engine/core.h"`,
      `@import UIKit;`,
      `  @import NetKit.Client ;`,
      `// @import Commented;`,
      `/* @import AlsoCommented; */`,
      `@class Forward, Declared;`,
      `@protocol OnlyPromised;`,
      `@protocol Themable <NSObject>`,
      `@end`,
      `@interface Track (Formatting)`,
      `@end`,
      `@interface Album : NSObject`,
      `@end`,
      `@implementation Album`,
      `- (void)log { NSLog(@"@import InString;"); }`,
      `@end`,
    ].join('\n'));
    expect(scan.imports).toEqual([
      { spec: 'Foundation/Foundation.h', kind: 'include-system' },
      { spec: 'Track.h', kind: 'include' },
      { spec: 'engine/core.h', kind: 'include' },
      { spec: 'UIKit', kind: 'module' },
      { spec: 'NetKit.Client', kind: 'module' },
    ]);
    expect(scan.decls).toEqual({ classes: ['Themable', 'Track', 'Album'] });
    expect(objc.extensions).toEqual(['m', 'mm']);
  });
});

describe('objc resolver', () => {
  const index = createRepoIndex([
    facts('App/main.m'), facts('App/Bridge.mm'), facts('App/View.h'),
    facts('Engine/mesh.hpp'), facts('Engine/mesh.cpp'), facts('Engine/clock.h'), facts('Engine/clock.c'),
    facts('Pods/Charts/Charts.h'), facts('Pods/Charts/Axis.h'),
    facts('Vendor/Sodium/shim.h'), facts('Vendor/Sodium/extra.h'),
    facts('Vendor/Sodium/module.modulemap', '', 'module Sodium [system] {\n  header "shim.h"\n  // header "extra.h"\n  link "sodium"\n  export *\n}\n'),
    facts('Frameworks/Ink.framework/Headers/Ink.h'),
    facts('Frameworks/Ink.framework/Modules/module.modulemap', '', 'framework module Ink {\n  umbrella header "Ink.h"\n  module * { export * }\n}\n'),
  ]);
  const to = (from: string, spec: string, kind: string) => {
    const file = index.get(from)!;
    return family.find((p) => p.id === file.lang)!.createResolver!(index).resolve(file, { spec, kind }).map((r) => r.path);
  };

  it('resolves @import through an umbrella header or a module map, and not otherwise', () => {
    expect(to('App/main.m', 'Charts', 'module')).toEqual(['Pods/Charts/Charts.h']);
    expect(to('App/main.m', 'Charts.Axis', 'module')).toEqual(['Pods/Charts/Axis.h']);
    expect(to('App/main.m', 'Sodium', 'module')).toEqual(['Vendor/Sodium/shim.h']);
    expect(to('App/main.m', 'Ink', 'module')).toEqual(['Frameworks/Ink.framework/Headers/Ink.h']);
    expect(to('App/main.m', 'Foundation', 'module')).toEqual([]);
    expect(to('App/main.m', 'Darwin.POSIX', 'module')).toEqual([]);
  });

  it('shares one header namespace with C and C++', () => {
    expect(to('App/Bridge.mm', 'mesh.hpp', 'include')).toEqual(['Engine/mesh.hpp']);  // Obj-C++ → C++ header
    expect(to('App/main.m', 'Engine/clock.h', 'include-system')).toEqual(['Engine/clock.h']); // Obj-C → C header
    expect(to('Engine/mesh.cpp', 'View.h', 'include')).toEqual(['App/View.h']);        // C++ → Obj-C header
    expect(to('App/main.m', 'Charts/Axis.h', 'include-system')).toEqual(['Pods/Charts/Axis.h']); // framework style
    expect(to('App/main.m', 'UIKit/UIKit.h', 'include-system')).toEqual([]);
  });
});

describe('objc symbols', () => {
  it('reads inheritance, protocols and message sends, and is not fooled by subscripts or literals', () => {
    const { defs, refs } = extractObjcSymbols([
      `@protocol Themable <NSObject>`,
      `- (void)applyTheme:(Theme *)theme;`,
      `@end`,
      `@protocol Forward;`,
      `@interface Panel : BaseView <Themable, UITableViewDelegate> {`,
      `    int _count;`,
      `}`,
      `@end`,
      `@interface Panel ()`,
      `@property (nonatomic, strong) id<Themable> child;`,
      `@end`,
      `@implementation Panel`,
      `- (void)applyTheme:(Theme *)theme {`,
      `    NSArray *rows = @[[Row rowWithTitle:@"a [b c]"], rows[0]];`,
      `    int grid[4]; grid[idx next] = 0;`,
      `    if ([(Panel *)self.child isReady]) [[Palette shared] apply:theme to:self animated:YES];`,
      `    [(theme ?: Theme.fallback) activate];`,
      `    return [rows count] > 0 ? [super applyTheme:theme] : (void)0;`,
      `}`,
      `+ (BOOL)requiresSetup { return NO; }`,
      `@end`,
      `void PanelRegister(void) { PanelInstall(sizeof(int)); }`,
    ].join('\n'), 'Panel.m');

    expect(defs.map((d) => `${d.kind} ${d.container ? d.container + '.' : ''}${d.name}:${d.line}`)).toEqual([
      'interface Themable:1', 'class Panel:5', 'method Panel.applyTheme:13', 'method Panel.requiresSetup:20', 'function PanelRegister:22',
    ]);
    expect(refs.filter((r) => r.kind === 'inherit').map((r) => r.name)).toEqual(['NSObject', 'BaseView', 'Themable', 'UITableViewDelegate']);
    const calls = refs.filter((r) => r.kind === 'call').map((r) => (r.qualifier ? `${r.qualifier}.` : '') + r.name).sort();
    expect(calls).toEqual(['BaseView.applyTheme', 'Palette.shared', 'PanelInstall', 'Row.rowWithTitle', 'Theme.fallback', 'activate', 'apply', 'count', 'isReady'].sort());
    expect(ref(refs, 'Themable', 'type')).toBeDefined();
    expect(ref(refs, 'Theme', 'type')?.count).toBe(2);
    expect(ref(refs, 'Row', 'reference')).toBeDefined();
  });

  it('never throws on broken input', () => {
    for (const text of ['', '@implementation', '- (void', '[[[', '}}}{{{ @end', '@interface A : <', '"unterminated\n[a b', '#define X(a) \\\n  [a b]\n'])
      expect(() => extractObjcSymbols(text, 'x.mm')).not.toThrow();
    expect(extractObjcSymbols('#define SEND(a) \\\n  [a notify]\n', 'x.m').refs).toEqual([]);
  });
});
