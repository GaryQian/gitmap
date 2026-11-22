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

// ---- small repos written inline: one rule of PLAN.md §6.4.1 each ----

/** Bridge keys of every file of a small repo (path → text), as the fast pass would store them. */
function scanRepo(repo: Record<string, string>): BridgeFile[] {
  return Object.entries(repo).map(([path, text]) => ({ path, bridge: extractBridgeKeys({ path, lang: null, text, imports: importsOf(path, text) }, enabled) }));
}
/** The links of a small repo as "src → dst" lines with their mechanism, one per file pair. */
function linksOf(repo: Record<string, string>): string[] {
  return bridgeRawEdges(linkBridges(scanRepo(repo))).map((e) => `${e.src} → ${e.dst} [${e.kind} ${e.mechanism}]`).sort();
}

describe('JNI names in source', () => {
  // The three escapes of the specification and an overloaded pair, as javac -h would name them.
  const symbols = [
    mangleJni('com.foo_bar.My_Class', 'do_it'),
    mangleJni('com.foo_bar.My_Class$Inner', 'run'),
    mangleJni('com.foo_bar.My_Class', 'put', 'I'),
    mangleJni('com.foo_bar.My_Class', 'put', 'Ljava/lang/String;[J'),
  ];
  const native = ['#include <jni.h>', ...symbols.map((s) => `JNIEXPORT void JNICALL ${s}(JNIEnv *env, jobject self) {}`)].join('\n');
  const java = [
    'package com.foo_bar;',
    'public class My_Class {',
    '  public native void do_it();',
    '  public native void put(int value);',
    '  public native void put(String key, long[] values);',
    '  static class Inner { native void run(); }',
    '}',
  ].join('\n');

  it('writes the escapes _1, _00024 and the __signature suffix, and reads each symbol back', () => {
    expect(symbols[0]).toContain('foo_1bar_My_1Class_do_1it');
    expect(symbols[1]).toContain('My_1Class_00024Inner_run');
    expect(symbols[2]).toMatch(/_put__I$/);
    expect(symbols[3]).toMatch(/_put__Ljava_lang_String_2_3J$/);
    for (const symbol of symbols) {
      const name = demangleJni(symbol)!;
      expect(mangleJni(name.className, name.method, name.signature), symbol).toBe(symbol);
    }
  });

  it('gives a mangled C++ definition and the Java native method the same key, overloads sharing one', () => {
    const provides = extractBridgeKeys({ path: 'native/my_class.cpp', lang: null, text: native, imports: [] }, enabled).provides;
    const consumes = extractBridgeKeys({ path: 'java/com/foo_bar/My_Class.java', lang: null, text: java, imports: [] }, enabled).consumes;
    const keys = ['jni:com.foo_bar.My_Class#do_it', 'jni:com.foo_bar.My_Class$Inner#run', 'jni:com.foo_bar.My_Class#put'];
    expect([...provides].sort()).toEqual([...keys].sort());
    expect([...consumes].sort()).toEqual([...keys].sort());
    expect(linksOf({ 'java/com/foo_bar/My_Class.java': java, 'native/my_class.cpp': native }))
      .toEqual(['java/com/foo_bar/My_Class.java → native/my_class.cpp [bridge jni]']);
  });

  it('does not join a native method to a function mangled for another class', () => {
    const other = `JNIEXPORT void JNICALL ${mangleJni('com.foo_bar.Other', 'do_it')}(JNIEnv *env, jobject self) {}`;
    expect(linksOf({ 'java/com/foo_bar/My_Class.java': java, 'native/other.cpp': other })).toEqual([]);
  });
});

describe('RegisterNatives tables', () => {
  const java = 'package com.foo;\npublic class Bar {\n  native void start(long handle);\n  native void stop(long handle);\n}\n';
  const table = (className: string) => [
    '#include <jni.h>',
    'static void start(JNIEnv *env, jobject self, jlong handle) {}',
    'static void stop(JNIEnv *env, jobject self, jlong handle) {}',
    'static const JNINativeMethod kMethods[] = {',
    '  {"start", "(J)V", (void *) start},',
    '  {"stop", "(J)V", (void *) stop},',
    '};',
    'jint JNI_OnLoad(JavaVM *vm, void *reserved) {',
    '  JNIEnv *env;',
    '  (*vm)->GetEnv(vm, (void **) &env, JNI_VERSION_1_6);',
    `  jclass clazz = (*env)->FindClass(env, "${className}");`,
    '  (*env)->RegisterNatives(env, clazz, kMethods, 2);',
    '  return JNI_VERSION_1_6;',
    '}',
  ].join('\n');

  it('provides one key per table entry, for the class found with FindClass', () => {
    const keys = extractBridgeKeys({ path: 'native/onload.c', lang: null, text: table('com/foo/Bar'), imports: [] }, enabled);
    expect([...keys.provides].sort()).toEqual(['jni:com.foo.Bar#start', 'jni:com.foo.Bar#stop']);
    // The class was looked up only to register natives for it: that is not a call into the JVM.
    expect(keys.consumes).toEqual([]);
  });

  it('joins the Java class to the file holding its table, and to no table of another class', () => {
    expect(linksOf({ 'java/com/foo/Bar.java': java, 'native/onload.c': table('com/foo/Bar') })).toEqual(['java/com/foo/Bar.java → native/onload.c [bridge jni]']);
    expect(linksOf({ 'java/com/foo/Bar.java': java, 'native/onload.c': table('com/foo/Baz') })).toEqual([]);
  });
});

describe('JNI, native → JVM', () => {
  const native = [
    '#include <jni.h>',
    'void notify(JNIEnv *env, jobject target) {',
    '  jclass listener = env->FindClass("com/foo/Listener");',
    '  jmethodID onEvent = env->GetMethodID(listener, "onEvent", "(I)V");',
    '  jclass util = env->FindClass("com/foo/Util");',
    '  jmethodID now = env->GetStaticMethodID(util, "now", "()J");',
    '  jclass string = env->FindClass("java/lang/String");',
    '}',
  ].join('\n');
  const listener = 'package com.foo;\npublic class Listener {\n  void onEvent(int code) {}\n}\n';
  const util = 'package com.foo\n\nobject Util {\n  @JvmStatic fun now(): Long = 0L\n}\n';

  it('consumes the class named by FindClass, refined by the method name', () => {
    const keys = extractBridgeKeys({ path: 'native/notify.cpp', lang: null, text: native, imports: [] }, enabled);
    expect(keys.consumes).toContain('jvm:com.foo.Listener#onEvent');
    expect(keys.consumes).toContain('jvm:com.foo.Util#now');
    expect(keys.consumes.some((k) => k.startsWith('jvm:java.lang.String'))).toBe(true);
    expect(keys.provides).toEqual([]);
  });

  it('points from the native file to the Java and Kotlin classes, and nowhere for a class outside the repo', () => {
    expect(linksOf({ 'native/notify.cpp': native, 'app/java/com/foo/Listener.java': listener, 'app/kotlin/com/foo/Util.kt': util })).toEqual([
      'native/notify.cpp → app/java/com/foo/Listener.java [bridge jni]',
      'native/notify.cpp → app/kotlin/com/foo/Util.kt [bridge jni]',
    ]);
  });

  it('finds a class by its conventional path when the JVM file carries no keys', () => {
    const files: BridgeFile[] = [...scanRepo({ 'native/notify.cpp': native }), { path: 'app/java/com/foo/Listener.java' }, { path: 'other/Listener.java' }];
    expect(linkBridges(files)).toEqual([
      { src: 'native/notify.cpp', dst: 'app/java/com/foo/Listener.java', mechanism: 'jni', key: 'jvm:com.foo.Listener#onEvent', loose: true },
    ]);
  });

  it('draws nothing when two files declare the class', () => {
    const repo = { 'native/notify.cpp': native, 'app/java/com/foo/Listener.java': listener, 'tv/java/com/foo/Listener.java': listener };
    expect(linksOf(repo)).toEqual([]);
  });
});

describe('Protobuf stubs, one per generator', () => {
  const proto = 'syntax = "proto3";\nmessage Foo {}\n';
  // Code that imports the generated stub of foo.proto: foo_pb2.py, foo.pb.go (package foopb), foo_pb.ts, foo.pb.h.
  const importers: Record<string, string> = {
    'client/app.py': 'import foo_pb2\n\nprint(foo_pb2.Foo())\n',
    'server/main.go': 'package main\n\nimport (\n\t"fmt"\n\n\t"example.com/shop/gen/foopb"\n)\n\nfunc main() { fmt.Println(&foopb.Foo{}) }\n',
    'web/src/api.ts': "import { Foo } from './gen/foo_pb';\n\nexport const empty = new Foo();\n",
    'native/report.cc': '#include "foo.pb.h"\n\nint size(const Foo &foo) { return foo.ByteSize(); }\n',
  };

  it('joins every importer of a stub to the .proto file, which becomes the hub', () => {
    expect(linksOf({ ...importers, 'proto/foo.proto': proto, 'proto/bar.proto': proto })).toEqual(
      Object.keys(importers).sort().map((path) => `${path} → proto/foo.proto [bridge protobuf]`),
    );
  });

  it('joins a checked-in stub to its .proto as well', () => {
    const stubs = {
      'gen/foo_pb2.py': '# Generated by the protocol buffer compiler.  DO NOT EDIT!\n',
      'gen/foo.pb.go': '// Code generated by protoc-gen-go. DO NOT EDIT.\npackage foopb\n',
      'gen/foo_pb.ts': '// @generated by protoc-gen-es\nexport class Foo {}\n',
      'gen/foo.pb.h': '// Generated by the protocol buffer compiler.  DO NOT EDIT!\n#pragma once\n',
    };
    expect(linksOf({ ...stubs, 'proto/foo.proto': proto })).toEqual(Object.keys(stubs).sort().map((path) => `${path} → proto/foo.proto [bridge protobuf]`));
  });

  it('draws nothing without the .proto, and nothing for an import that only looks similar', () => {
    expect(linksOf(importers)).toEqual([]);
    expect(linksOf({ 'client/app.py': 'import foo\nimport foo_pb3\n', 'web/src/api.ts': "import { x } from './foo';\n", 'proto/foo.proto': proto })).toEqual([]);
  });

  it('draws nothing for a stub name two .proto files answer to, unless the import names the directory', () => {
    const two = { 'proto/billing/foo.proto': proto, 'proto/stock/foo.proto': proto };
    expect(linksOf({ ...two, 'client/app.py': 'import foo_pb2\n' })).toEqual([]);
    expect(linksOf({ ...two, 'client/app.py': 'from billing import foo_pb2\n' })).toEqual(['client/app.py → proto/billing/foo.proto [bridge protobuf]']);
    // The most specific form that anyone provides decides: an ambiguous one is not retried more loosely.
    const files: BridgeFile[] = [
      { path: 'a/v1/foo.proto' }, { path: 'b/v1/foo.proto' }, { path: 'foo.proto' },
      { path: 'client/app.py', bridge: { consumes: ['proto:v1/foo'] } },
    ];
    expect(linkBridges(files)).toEqual([]);
  });
});
