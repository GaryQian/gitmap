// Protobuf stubs (PLAN.md §6.4.1), matched by file name and path only; `.proto` files are not parsed.
//
//   provides  proto:<dir>/<stem> and proto:<stem>   the file <dir>/<stem>.proto
//   consumes  proto:<dir>/<stem>                    a file importing a generated stub of <stem>.proto,
//                                                   <dir> being whatever directory the import names
//             proto:<stem>                          …when the import names no directory
//
// The stub names are fixed by the generators: foo_pb2 / foo_pb2_grpc (Python), foo_pb / foo_grpc_pb
// (JS/TS), foo.pb.h / foo.grpc.pb.h (C++), FooOuterClass (Java), foo.pb.dart, foo_pb (Ruby). Go's
// package path is chosen by the .proto author, so Go is matched by the `foopb` naming convention only.
import type { ImportSpec } from '../contracts/lang';
import { basename, dirname } from '../shared';
import type { KeySink } from './types';

export type StubFamily = 'python' | 'js' | 'c' | 'go' | 'jvm' | 'dart' | 'ruby';

/** Both forms of the key of a `.proto` file; empty for any other path. */
export function protoProvides(path: string): string[] {
  if (!/\.proto$/i.test(path)) return [];
  const full = path.slice(0, -6);
  const stem = basename(full);
  if (!stem) return [];
  return full === stem ? ['proto:' + stem] : ['proto:' + full, 'proto:' + stem];
}

/** Join and normalise a '/'-separated path; '..' never climbs above the repo root. */
function joinPath(base: string, rel: string): string {
  const out: string[] = [];
  for (const seg of (base ? base + '/' + rel : rel).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}

function key(dir: string, stem: string): string {
  return dir ? `proto:${dir}/${stem}` : `proto:${stem}`;
}

const PY_STUB = /^(.+?)_pb2(?:_grpc)?$/;
const JS_EXT = /\.(?:d\.ts|[cm]?[jt]sx?)$/;
const JS_STUB = /^(.+?)(?:_grpc_web_pb|_grpc_pb|_pb_service|_pb|\.pb)$/;
const C_STUB = /^(.+?)(?:\.grpc\.pb|\.pb|\.pbobjc|\.pbrpc)\.h$/;
const GO_STUB = /^(.+?)(?:_go_proto|_proto|pb)$/;
const JVM_STUB = /^([A-Z][A-Za-z0-9]*?)(?:OuterClass|Grpc|Protos?)$/;
const DART_STUB = /^(.+?)\.pb(?:grpc|enum|json)?\.dart$/;
const RUBY_STUB = /^(.+?)(?:_services_pb|_pb)$/;

/** FooBar → foo_bar: the file name protoc's Java generator camel-cased. */
function snakeCase(camel: string): string {
  return camel.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** A path-like specifier split into the directory it names and its last segment. */
function splitSpec(spec: string, fileDir: string, relative: boolean): { dir: string; last: string } {
  const path = relative ? joinPath(fileDir, spec) : joinPath('', spec);
  return { dir: dirname(path), last: basename(path) };
}

/** Keys consumed by one import statement of a file in `fileDir`. */
function stubKeys(family: StubFamily, imp: ImportSpec, fileDir: string, out: Set<string>): void {
  const spec = imp.spec;
  if (!spec || spec.length > 1000) return;
  switch (family) {
    case 'python': {
      // `import a.b.foo_pb2`, `from a.b import foo_pb2`, `from .gen import foo_pb2_grpc`, `from a.foo_pb2 import Msg`
      let dots = 0;
      while (spec.charCodeAt(dots) === 46) dots++;
      const segs = spec.slice(dots).split('.').filter(Boolean);
      const base = dots > 0 ? joinPath(fileDir, '../'.repeat(dots - 1)) : '';
      const dirOf = (parts: string[]) => joinPath(base, parts.join('/'));
      const last = segs.length ? PY_STUB.exec(segs[segs.length - 1]) : null;
      if (last) { out.add(key(dirOf(segs.slice(0, -1)), last[1])); return; }
      for (const name of imp.names ?? []) {
        const m = PY_STUB.exec(name);
        if (m) out.add(key(dirOf(segs), m[1]));
      }
      return;
    }
    case 'js': {
      const clean = spec.replace(/[?#].*$/, '').replace(JS_EXT, '');
      const { dir, last } = splitSpec(clean, fileDir, clean.startsWith('.'));
      const m = JS_STUB.exec(last);
      if (m) out.add(key(dir, m[1]));
      return;
    }
    case 'c': {
      const { dir, last } = splitSpec(spec, fileDir, spec.startsWith('.'));
      const m = C_STUB.exec(last);
      if (m) out.add(key(dir, m[1]));
      return;
    }
    case 'go': {
      // The package path is chosen in the .proto (go_package), so only naming conventions are left:
      // a package called foopb / foo_go_proto, or one imported under such an alias
      // (`stockpb "example.com/shop/gen/inventory/v1"`, where the path may mirror the .proto's directory).
      const path = joinPath('', spec);
      const m = GO_STUB.exec(basename(path));
      if (m) { out.add(key(dirname(path), m[1])); return; }
      const alias = imp.names?.length === 1 ? GO_STUB.exec(imp.names[0]) : null;
      if (alias) out.add(key(path, alias[1]));
      return;
    }
    case 'jvm': {
      // com.foo.proto.FooOuterClass.Msg — the directory is the Java package, which mirrors the
      // .proto's directory in the usual src/main/proto layout.
      const segs = spec.split('.');
      for (let i = 0; i < segs.length; i++) {
        const m = JVM_STUB.exec(segs[i]);
        if (m) { out.add(key(segs.slice(0, i).join('/'), snakeCase(m[1]))); return; }
      }
      // Scala selectors: `import com.foo.proto.{FooOuterClass, Other}`
      for (const name of imp.names ?? []) {
        const m = JVM_STUB.exec(name);
        if (m) out.add(key(segs.join('/'), snakeCase(m[1])));
      }
      return;
    }
    case 'dart': {
      if (spec.startsWith('dart:')) return;
      const pkg = /^package:[^/]+\/(.+)$/.exec(spec);
      const { dir, last } = pkg ? splitSpec(pkg[1], '', false) : splitSpec(spec, fileDir, !spec.includes(':'));
      const m = DART_STUB.exec(last);
      if (m) out.add(key(dir, m[1]));
      return;
    }
    case 'ruby': {
      const clean = spec.replace(/\.rb$/, '');
      const { dir, last } = splitSpec(clean, fileDir, clean.startsWith('.') || imp.kind.includes('relative'));
      const m = RUBY_STUB.exec(last);
      if (m) out.add(key(dir, m[1]));
      return;
    }
  }
}

// A generated stub that is checked into the repo is itself derived from the .proto.
const STUB_FILE: Record<StubFamily, RegExp> = {
  python: /^(.+?)_pb2(?:_grpc)?\.pyi?$/,
  js: /^(.+?)(?:_grpc_web_pb|_grpc_pb|_pb_service|_pb|\.pb)\.(?:d\.ts|[cm]?[jt]s)$/,
  c: /^(.+?)(?:\.grpc\.pb|\.pb|\.pbobjc|\.pbrpc)\.(?:h|cc|c|m)$/,
  go: /^(.+?)(?:_grpc)?\.pb(?:\.gw)?\.go$/,
  jvm: /^([A-Z][A-Za-z0-9]*?)(?:OuterClass|Grpc)\.(?:java|kt)$/,
  dart: /^(.+?)\.pb(?:grpc|enum|json)?\.dart$/,
  ruby: /^(.+?)(?:_services_pb|_pb)\.rb$/,
};

/**
 * Keys a file consumes through Protobuf stubs: one per import of a generated stub, plus its own
 * key when the file is itself a checked-in stub (`gen/foo_pb.js` consumes `proto:gen/foo`).
 */
export function extractProtoConsumes(family: StubFamily, path: string, imports: readonly ImportSpec[], out: KeySink): void {
  const fileDir = dirname(path);
  const own = STUB_FILE[family].exec(basename(path));
  if (own) out.consumes.add(key(fileDir, family === 'jvm' ? snakeCase(own[1]) : own[1]));
  for (const imp of imports) if (imp && typeof imp.spec === 'string') stubKeys(family, imp, fileDir, out.consumes);
}
