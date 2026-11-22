// Bridges end to end (PLAN.md §6.4.1): the real fast pass leaves the keys on each file (the plug-ins
// scan imports, the trigger sweep decides which files are read for JNI names), and `analyze` joins
// them into unit edges of kind 'bridge' that record their mechanism.
import { describe, expect, it } from 'vitest';
import { analyze } from '../analysis';
import { collectTasks } from '../compute';
import { config } from '../config';
import type { AnalysisResult } from '../contracts/pipeline';
import { buildManifest, runFastPass } from '../ingest';
import { edgeId } from '../model';
import { fixtureExpected, fixtureFiles } from '../testing/fixture';
import { createFakePool, memoryRepo } from '../testing/memory';
import type { BridgeEdge } from './index';

const tasks = collectTasks(import.meta.glob('../ingest/**/*.task.ts', { eager: true }));

/** Fast pass and analysis of a small repo given as path → text. */
async function analyzeRepo(name: string, files: Record<string, string>): Promise<AnalysisResult> {
  const repo = memoryRepo(name, files);
  const pool = createFakePool({ config, tasks, repo });
  const manifest = await buildManifest(repo, config);
  const facts = await runFastPass(manifest, pool, config);
  return analyze({ repoName: name, files: facts }, config);
}

/** "src → dst" (unit ids) → [kind, mechanism] of every bridge edge. */
function bridgeEdges(result: AnalysisResult): Map<string, string> {
  const { edge } = result.tables;
  const out = new Map<string, string>();
  edge.ids.forEach((_, e) => {
    if (edge.cols.kind![e] === 'bridge') out.set(`${edge.cols.src![e]} → ${edge.cols.dst![e]}`, edge.cols.mechanism![e]);
  });
  return out;
}

describe('bridge fixtures through the fast pass and analyze', () => {
  for (const [fixture, mechanism] of [['bridges/jni', 'jni'], ['bridges/proto', 'protobuf']] as const) {
    it(`draws every expected ${mechanism} link of fixtures/${fixture} as a bridge edge, and no other`, async () => {
      const expected = fixtureExpected<{ edges: BridgeEdge[] }>(fixture).edges;
      const result = await analyzeRepo(fixture, fixtureFiles(fixture));
      const { file, edge } = result.tables;
      const unitOf = (path: string) => file.cols.unit![file.ids.indexOf(path)];

      // One link per key in the fixture; the map draws one edge per pair of units.
      expect(result.diagnostics.bridges).toBe(expected.length);
      const wanted = new Set<string>();
      for (const link of expected) {
        expect(link.mechanism).toBe(mechanism);
        const src = unitOf(link.src), dst = unitOf(link.dst);
        expect(src, link.src).toBeTruthy();
        expect(dst, link.dst).toBeTruthy();
        if (src === dst) continue;
        wanted.add(`${src} → ${dst}`);
        const e = edge.ids.indexOf(edgeId(src, dst));
        expect(e, `${link.src} → ${link.dst}`).toBeGreaterThanOrEqual(0);
        // 'bridge' is the strongest kind: it wins over an import or a reference on the same pair.
        expect([edge.cols.kind![e], edge.cols.mechanism![e]], `${link.src} → ${link.dst}`).toEqual(['bridge', mechanism]);
        expect(edge.cols.confidence![e]).toBeGreaterThan(0);
        expect(edge.cols.weight![e]).toBeGreaterThan(0);
      }
      expect([...bridgeEdges(result).keys()].sort()).toEqual([...wanted].sort());
      // No other edge claims a mechanism.
      edge.ids.forEach((_, e) => { if (edge.cols.kind![e] !== 'bridge') expect(edge.cols.mechanism![e]).toBe(''); });
    });
  }

  it('covers both directions and both ways of binding in the JNI fixture', async () => {
    const result = await analyzeRepo('bridges/jni', fixtureFiles('bridges/jni'));
    const bridges = bridgeEdges(result);
    const java = 'app/src/main/java/com/example/media/';
    // Java `native` → the C++ file defining Java_…  (decoder_jni.h is the same unit as its .cpp)
    expect(bridges.get(`${java}Decoder.java → native/decoder_jni.cpp`)).toBe('jni');
    // Java `native` → the file holding its RegisterNatives table
    expect(bridges.get(`${java}Player.java → native/register.cpp`)).toBe('jni');
    // native → JVM: FindClass + GetMethodID point at the Java class
    expect(bridges.get(`native/callbacks.cpp → ${java}Listener.java`)).toBe('jni');
    expect(bridges.get(`native/callbacks.cpp → ${java}Decoder.java`)).toBe('jni');
    // Kotlin `external fun` → C
    expect(bridges.get('app/src/main/kotlin/com/example/media/Codec.kt → native/codec_jni.c')).toBe('jni');
  });

  it('makes the .proto file the hub between client and server', async () => {
    const result = await analyzeRepo('bridges/proto', fixtureFiles('bridges/proto'));
    const hub = 'proto/inventory/v1/stock.proto';
    const into = [...bridgeEdges(result).keys()].filter((k) => k.endsWith(` → ${hub}`)).map((k) => k.split(' → ')[0]).sort();
    expect(into).toEqual(['client/app.py', 'native/report.cc', 'server/go/main.go', 'server/src/service.ts']);
    // a .proto file is a unit like any other, and counts its dependents
    const { unit } = result.tables;
    expect(unit.cols.fanIn![unit.ids.indexOf(hub)]).toBe(into.length);
  });

  it('draws no bridge for a native method two files implement', async () => {
    const java = 'package com.foo;\n\npublic class Bar {\n  public native void load();\n  public native void save();\n}\n';
    const impl = (names: string[]) => ['#include <jni.h>', ...names.map((n) => `JNIEXPORT void JNICALL Java_com_foo_Bar_${n}(JNIEnv *env, jobject self) {}`)].join('\n') + '\n';
    const both = await analyzeRepo('ambiguous', {
      'java/com/foo/Bar.java': java, 'linux/bar.c': impl(['load']), 'windows/bar.c': impl(['load']),
    });
    expect(both.diagnostics.bridges).toBe(0);
    expect([...bridgeEdges(both).keys()]).toEqual([]);
    // Only the key with one provider links: `save` exists on Linux alone.
    const one = await analyzeRepo('ambiguous', {
      'java/com/foo/Bar.java': java, 'linux/bar.c': impl(['load', 'save']), 'windows/bar.c': impl(['load']),
    });
    expect(one.diagnostics.bridges).toBe(1);
    expect([...bridgeEdges(one)]).toEqual([['java/com/foo/Bar.java → linux/bar.c', 'jni']]);
  });
});
