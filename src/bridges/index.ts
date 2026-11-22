// Cross-language bridges (PLAN.md §6.4.1): JNI and Protobuf stubs. A pure library — see README.md
// for the key namespace and for where each function is called at integration.
import type { ImportSpec } from '../contracts/lang';
import { extname } from '../shared';
import { extractJvm, type JvmLang } from './jvm';
import { extractNative } from './native';
import { extractProtoConsumes, protoProvides, type StubFamily } from './proto';
import type { BridgeKeys, BridgeMechanism, KeySink } from './types';

export { demangleJni, mangleJni, type JniName } from './jni';
export { bridgeRawEdges, linkBridges, type BridgeFile, type BridgeRawEdge } from './link';
export { protoProvides } from './proto';
export type { BridgeEdge, BridgeKeys, BridgeMechanism } from './types';

/**
 * Trigger words per mechanism, for the fast pass's multi-pattern sweep: a file that contains none
 * of the words of any enabled mechanism has no bridge keys to extract (a `.proto` file aside —
 * its keys come from its path). The words are case-sensitive substrings.
 */
export const BRIDGE_TRIGGERS: Record<BridgeMechanism, string[]> = {
  // JVM side: `native`, `external`. Native side: the rest. JNINativeMethod covers registration
  // through a wrapper (jniRegisterNativeMethods) that never spells RegisterNatives.
  jni: ['native', 'external', 'JNIEXPORT', 'Java_', 'RegisterNatives', 'JNINativeMethod', 'FindClass', 'GetMethodID'],
  // Stub-name suffixes as they appear in import specifiers: foo_pb2, foo_pb, foo.pb.h, foo.pb.dart,
  // "…/foopb" (Go), "…/foo_go_proto", FooOuterClass, FooGrpc, FooProto(s).
  protobuf: ['_pb', '.pb', 'pb"', '_proto"', 'OuterClass', 'Grpc', 'Proto'],
};

type Family = JvmLang | 'c' | 'python' | 'js' | 'go' | 'dart' | 'ruby' | 'proto';

const FAMILY_OF_EXTENSION: Record<string, Family> = {
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', sc: 'scala',
  c: 'c', cc: 'c', cpp: 'c', cxx: 'c', h: 'c', hh: 'c', hpp: 'c', hxx: 'c', m: 'c', mm: 'c',
  py: 'python', pyi: 'python', go: 'go', dart: 'dart', rb: 'ruby', proto: 'proto',
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  vue: 'js', svelte: 'js', astro: 'js',
};
const FAMILY_OF_LANG: Record<string, Family> = {
  java: 'java', kotlin: 'kotlin', scala: 'scala', c: 'c', cpp: 'c', objc: 'c', 'objective-c': 'c',
  python: 'python', go: 'go', dart: 'dart', ruby: 'ruby',
  ts: 'js', js: 'js', tsx: 'js', jsx: 'js', vue: 'js', svelte: 'js', astro: 'js',
};
const STUB_FAMILY: Partial<Record<Family, StubFamily>> = {
  java: 'jvm', kotlin: 'jvm', scala: 'jvm', c: 'c', python: 'python', js: 'js', go: 'go', dart: 'dart', ruby: 'ruby',
};

/** Mechanism families a file belongs to, from its extension first and its plug-in id second. */
function familyOf(path: string, lang: string | null): Family | undefined {
  return FAMILY_OF_EXTENSION[extname(path)] ?? (lang ? FAMILY_OF_LANG[lang] : undefined);
}

/**
 * The Protobuf keys a file consumes, from its path and imports alone (no text): one per import of
 * a generated stub, plus its own key when the file is itself a checked-in stub. This is the
 * Protobuf half of `extractBridgeKeys`, exported because it can also run at analysis time, over
 * `FileFacts.imports`. Never throws.
 */
export function protoConsumes(file: { path: string; lang: string | null; imports?: readonly ImportSpec[] }): string[] {
  const out: KeySink = { provides: new Set(), consumes: new Set() };
  try {
    const family = familyOf(file.path, file.lang);
    const stubs = family ? STUB_FAMILY[family] : undefined;
    if (stubs) extractProtoConsumes(stubs, file.path, file.imports ?? [], out);
  } catch {
    // keep what was found
  }
  return [...out.consumes];
}

export interface BridgeInput {
  /** Repo-relative path. */
  path: string;
  /** Plug-in id of the file, or null; the path's extension decides first, so this is only a fallback. */
  lang: string | null;
  text: string;
  /** The file's imports as its plug-in's scanner returned them. */
  imports: readonly ImportSpec[];
}

/**
 * Bridge keys of one file, for the mechanisms listed in `enabled` (`config.parser.bridges`).
 * Never throws and is linear in the text. Comments and string contents are skipped: a `native` in
 * a comment is not a method. Keys come back in first-seen order, each once.
 *
 * Cheap to call on a file with nothing to find: the JNI scan of a native file starts only when one
 * of its trigger words is present, and the Protobuf part reads `imports` alone. A JVM file is
 * always swept once, for the classes it declares.
 */
export function extractBridgeKeys(input: BridgeInput, enabled: readonly string[]): BridgeKeys {
  const out: KeySink = { provides: new Set(), consumes: new Set() };
  try {
    const family = familyOf(input.path, input.lang);
    if (family) {
      const text = typeof input.text === 'string' ? input.text : '';
      if (enabled.includes('jni')) {
        if (family === 'java' || family === 'kotlin' || family === 'scala') extractJvm(input.path, family, text, out);
        else if (family === 'c') extractNative(text, out);
      }
      if (enabled.includes('protobuf')) {
        if (family === 'proto') for (const key of protoProvides(input.path)) out.provides.add(key);
        const stubs = STUB_FAMILY[family];
        if (stubs) extractProtoConsumes(stubs, input.path, input.imports ?? [], out);
      }
    }
  } catch {
    // A file the extractors cannot read keeps whatever was found before the failure.
  }
  return { provides: [...out.provides], consumes: [...out.consumes] };
}
