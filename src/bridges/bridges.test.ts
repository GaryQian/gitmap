import { describe, expect, it } from 'vitest';
import { config } from '../config';
import type { ImportSpec } from '../contracts/lang';
import { scanIncludes } from '../lang/cfamily';
import { scanPythonImports } from '../lang/python';
import { scanImports } from '../lang/ts';
import { fixtureExpected, fixtureFiles } from '../testing/fixture';
import {
  BRIDGE_TRIGGERS, bridgeRawEdges, demangleJni, extractBridgeKeys, linkBridges, mangleJni, protoConsumes, protoProvides,
  type BridgeEdge, type BridgeFile,
} from './index';

const enabled = config.parser.bridges;

/** Imports as the fast pass would hand them over. Java and Go are read with a pattern, to keep this test independent of plug-ins still being written. */
function importsOf(path: string, text: string): ImportSpec[] {
  if (path.endsWith('.py')) return scanPythonImports(text).imports;
  if (path.endsWith('.ts')) return scanImports(text).imports;
  if (/\.(?:c|cc|cpp|h)$/.test(path)) return scanIncludes(text).imports;
  if (path.endsWith('.java')) return [...text.matchAll(/^import\s+(?:static\s+)?([\w.]+);/gm)].map((m) => ({ spec: m[1], kind: 'import' }));
  if (path.endsWith('.go')) return [...text.matchAll(/^\s*(?:import\s+)?(?:\w+\s+)?"([^"\n]+)"$/gm)].map((m) => ({ spec: m[1], kind: 'import' }));
  return [];
}

/** Every file of a fixture with its bridge keys. With `sweep`, only files that contain a trigger word are read, as in the fast pass. */
function scanFixture(name: string, sweep = false): BridgeFile[] {
  const words = enabled.flatMap((mechanism) => BRIDGE_TRIGGERS[mechanism as keyof typeof BRIDGE_TRIGGERS] ?? []);
  return Object.entries(fixtureFiles(name)).map(([path, text]) => {
    if (sweep && !words.some((w) => text.includes(w))) return { path };
    return { path, bridge: extractBridgeKeys({ path, lang: null, text, imports: importsOf(path, text) }, enabled) };
  });
}

const plain = (edges: BridgeEdge[]) => edges.map(({ src, dst, mechanism, key }) => ({ src, dst, mechanism, key }));

describe('JNI name mangling', () => {
  it('mangles as the JNI specification does', () => {
    expect(mangleJni('com.foo.Bar', 'load')).toBe('Java_com_foo_Bar_load');
    expect(mangleJni('com/foo/Bar', 'load')).toBe('Java_com_foo_Bar_load');
    expect(mangleJni('com.foo.Bar', 'native_init')).toBe('Java_com_foo_Bar_native_1init');
    expect(mangleJni('com.foo.Outer$Inner', 'run')).toBe('Java_com_foo_Outer_00024Inner_run');
    expect(mangleJni('com.foo.Bar', 'put', 'ILjava/lang/String;[J')).toBe('Java_com_foo_Bar_put__ILjava_lang_String_2_3J');
    expect(mangleJni('com.foo.Bar', 'put', '(I)V')).toBe('Java_com_foo_Bar_put__I');
    expect(mangleJni('com.foo.Bar', 'größe')).toBe('Java_com_foo_Bar_gr_000f6_000dfe');
  });

  it('round-trips through demangleJni, including _, $ and overloads', () => {
    const cases: [string, string, string?][] = [
      ['com.foo.Bar', 'load'],
      ['Bar', 'load'],
      ['com.foo_bar.My_Class', 'do_it_'],
      ['com.foo._hidden.Bar', '_init'],
      ['com.foo.Outer$Inner$Deep', 'run$default'],
      ['com.foo.Bar$Companion', 'probe'],
      ['com.foo.Bar', 'put', 'ILjava/lang/String;[J'],
      ['com.foo.Bar', 'put', '[[Lcom/foo/My_Class$Inner;'],
      ['com.foo.Bar', 'put', ''],
      ['com.foo.Bar', 'größe', 'Lcom/foo/Größe;'],
    ];
    for (const [className, method, signature] of cases) {
      const symbol = mangleJni(className, method, signature);
      expect(demangleJni(symbol), symbol).toEqual(signature === undefined ? { className, method } : { className, method, signature });
    }
    expect(demangleJni('Java_com_foo_Bar_00024Companion_probe')).toEqual({ className: 'com.foo.Bar$Companion', method: 'probe' });
    for (const bad of ['load', 'Java_', 'Java_load', 'Java_com_foo_', 'Java_com__foo', 'Java_com_2foo_bar', 'Java_com_foo-bar_x']) {
      expect(demangleJni(bad), bad).toBeNull();
    }
  });
});

describe('JNI bridge', () => {
  it('links the Java / Kotlin ↔ C / C++ fixture as expected', () => {
    const expected = fixtureExpected<{ edges: BridgeEdge[] }>('bridges/jni').edges;
    expect(linkBridges(scanFixture('bridges/jni'))).toEqual(expected);
    // Reading only the files the trigger sweep selects gives the same links: Listener.java holds no
    // trigger word, and is found through its path instead.
    const swept = scanFixture('bridges/jni', true);
    expect(swept.find((f) => f.path.endsWith('Listener.java'))?.bridge).toBeUndefined();
    expect(plain(linkBridges(swept))).toEqual(plain(expected));
  });

  it('keeps comments, strings and prototypes out of the keys', () => {
    const files = fixtureFiles('bridges/jni');
    const keys = (path: string) => extractBridgeKeys({ path, lang: null, text: files[path], imports: [] }, enabled);
    const decoder = keys('app/src/main/java/com/example/media/Decoder.java');
    expect(decoder.consumes).toEqual([
      'jni:com.example.media.Decoder#open', 'jni:com.example.media.Decoder#close',
      'jni:com.example.media.Decoder#read', 'jni:com.example.media.Decoder$Stats#count',
    ]);
    expect(decoder.provides).toEqual(['jvm:com.example.media.Decoder', 'jvm:com.example.media.Decoder$Stats']);
    const codec = keys('app/src/main/kotlin/com/example/media/Codec.kt');
    expect(codec.consumes).toEqual([
      'jni:com.example.media.Codec#init', 'jni:com.example.media.Codec#configure',
      'jni:com.example.media.Codec#version', 'jni:com.example.media.Codec$Companion#probe',
      'jni:com.example.media.Codec$Registry#size', 'jni:com.example.media.CodecKt#nativeLog',
    ]);
    expect(keys('native/decoder_jni.h')).toEqual({ provides: [], consumes: [] });
    expect(keys('native/decoder_jni.cpp').provides.join(' ')).not.toMatch(/Ghost/);
    expect(keys('native/register.cpp')).toEqual({
      provides: ['jni:com.example.media.CodecKt#nativeLog', 'jni:com.example.media.Player#nativeStart', 'jni:com.example.media.Player#nativeStop'],
      consumes: [],
    });
    // A mechanism that is not enabled yields nothing.
    expect(extractBridgeKeys({ path: 'a/Decoder.java', lang: 'java', text: files['app/src/main/java/com/example/media/Decoder.java'], imports: [] }, ['protobuf']))
      .toEqual({ provides: [], consumes: [] });
  });
});

describe('Protobuf stub bridge', () => {
  it('links the fixture as expected, with the .proto as the hub', () => {
    const expected = fixtureExpected<{ edges: BridgeEdge[] }>('bridges/proto').edges;
    const edges = linkBridges(scanFixture('bridges/proto'));
    expect(edges).toEqual(expected);
    // Client and server meet at the .proto file.
    const hub = edges.filter((e) => e.dst === 'proto/inventory/v1/stock.proto').map((e) => e.src);
    expect(hub).toEqual(['client/app.py', 'native/report.cc', 'server/go/main.go', 'server/src/service.ts']);
    expect(protoProvides('proto/inventory/v1/stock.proto')).toEqual(['proto:proto/inventory/v1/stock', 'proto:stock']);
    // The trigger sweep reads no .proto file (nothing claims them): the linker knows them by path.
    const swept = scanFixture('bridges/proto', true);
    expect(swept.filter((f) => f.path.endsWith('.proto')).every((f) => f.bridge === undefined)).toBe(true);
    expect(linkBridges(swept)).toEqual(expected);
    // The consumer side needs no text, so it can also be derived from stored imports.
    const files = fixtureFiles('bridges/proto');
    const app = 'client/app.py';
    expect(protoConsumes({ path: app, lang: 'python', imports: importsOf(app, files[app]) }))
      .toEqual(['proto:inventory/v1/stock', 'proto:invoice_items', 'proto:common/types', 'proto:types']);
    const raw = bridgeRawEdges(edges);
    expect(raw.every((e) => e.kind === 'bridge' && e.mechanism === 'protobuf' && e.count >= 1)).toBe(true);
  });
});

describe('linkBridges', () => {
  it('drops a key with more than one provider, never links a file to itself, and is order-independent', () => {
    const files: BridgeFile[] = [
      { path: 'Bar.java', bridge: { consumes: ['jni:com.foo.Bar#load', 'jni:com.foo.Bar#save', 'jni:com.foo.Bar#missing'] } },
      { path: 'linux/bar.c', bridge: { provides: ['jni:com.foo.Bar#load', 'jni:com.foo.Bar#save'] } },
      { path: 'windows/bar.c', bridge: { provides: ['jni:com.foo.Bar#load'] } },
      { path: 'self.cc', bridge: { provides: ['jni:x.Y#z'], consumes: ['jni:x.Y#z'] } },
      { path: 'plain.txt' },
    ];
    const expected = [{ src: 'Bar.java', dst: 'linux/bar.c', mechanism: 'jni', key: 'jni:com.foo.Bar#save' }];
    expect(linkBridges(files)).toEqual(expected);
    expect(linkBridges([...files].reverse())).toEqual(expected);
    expect(bridgeRawEdges(linkBridges(files))).toEqual([{ src: 'Bar.java', dst: 'linux/bar.c', kind: 'bridge', confidence: 1, count: 1, mechanism: 'jni' }]);
  });
});
