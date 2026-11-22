# Bridges: links between languages

Package 3K. Implements PLAN.md §6.4.1: every bridge is two sides agreeing on a name. Each file emits
keys in a shared namespace ("provides" / "consumes"), and a linker joins them with a hash map into
edges of kind `bridge` that record their mechanism. Direction is consumer → provider.

This folder is a pure library. Nothing in the pipeline calls it yet; "Where to call it" below is the
whole integration.

## Key namespace

| Key | Provided by | Consumed by | Mechanism |
|---|---|---|---|
| `jni:<class>#<method>` | a C/C++ function *defined* as `Java_<class>_<method>[__<sig>]`; a `JNINativeMethod` table entry registered for `<class>` | a Java `native` method, a Kotlin `external fun` | `jni` |
| `jvm:<class>` | a Java, Kotlin or Scala file, for each top-level and nested class it declares | C/C++ `FindClass("com/foo/Bar")` | `jni` |
| `jvm:<class>#<method>` | nobody (falls back to `jvm:<class>`) | `GetMethodID` / `GetStaticMethodID` on a class found with `FindClass` | `jni` |
| `proto:<dir>/<stem>`, `proto:<stem>` | the file `<dir>/<stem>.proto` (both forms) | a file importing a generated stub of it | `protobuf` |

`<class>` is a JVM binary name: dotted package, `$` before a nested class (`com.foo.Outer$Inner`).
Overloads share one key; the argument signature is dropped.

Details that decide whether two sides meet:

- **Kotlin.** `external fun` in class `Bar` → `Bar`; in `object Foo` → `Foo`; in a `companion object`
  → `Bar` with `@JvmStatic`, `Bar$Companion` (or `Bar$Name`) without; at top level → the file's facade
  class, `FooKt` for `foo.kt`, or the name in `@file:JvmName("…")`.
- **Only definitions provide.** A `Java_…` prototype (a `javac -h` header) is not a provider, or
  header and implementation would both provide the key and the ambiguity rule would drop it.
- **`RegisterNatives`.** A table's class is the string or `jclass` variable passed to the call that
  names the table (`RegisterNatives`, `jniRegisterNativeMethods`, `registerNativeMethods`); a table
  no call accounts for takes the file's one `FindClass`, if there is exactly one. A class looked up
  only to register natives for it is not also consumed as `jvm:`.
- **Protobuf consumers** emit one key per stub import: the stem with whatever directory the import
  names (`from inventory.v1 import stock_pb2` → `proto:inventory/v1/stock`; `./gen/stock_pb` from
  `web/src/a.ts` → `proto:web/src/gen/stock`), or the bare stem when it names none. Stub names
  recognised: `foo_pb2`, `foo_pb2_grpc` (Python); `foo_pb`, `foo_grpc_pb`, `foo_grpc_web_pb`,
  `foo_pb_service`, `foo.pb` (JS/TS); `foo.pb.h`, `foo.grpc.pb.h`, `Foo.pbobjc.h`, `Foo.pbrpc.h`
  (C family); `FooOuterClass`, and by convention `FooGrpc`, `FooProto(s)` (JVM); `foo.pb.dart` and
  friends (Dart); `foo_pb`, `foo_services_pb` (Ruby); a Go package or import alias named `foopb`,
  `foo_go_proto` or `foo_proto`. A checked-in stub file (`gen/foo_pb.js`) consumes its own proto too.

## How the linker matches

`linkBridges` tries a consumed key from most to least specific; the first form that has any provider decides.

- `jni:` — exact.
- `jvm:C#m` → `jvm:C` → the class's conventional path, `…/<package dirs>/<TopLevelClass>.java|kt|scala`
  (`FooKt` → `foo.kt`). The path step means a JVM file does not have to be scanned to be linked to.
- `proto:a/b/foo` → `proto:b/foo` → `proto:foo`. A `.proto` answers to every trailing part of its own
  path, because a stub import names the path from some unknown root (the include root, the Python
  package root, the generator's output folder). Stems are compared folded (lower case, no `_` or
  `-`), so `FooBarOuterClass` meets `foo_bar.proto`. `.proto` files are known to the linker by path;
  they need no stored keys.

**Ambiguity rule:** a form with more than one provider produces no edge — the search does not go
on to a looser form. A file never bridges to itself. Edges come out sorted by `(src, dst, key)`.

An edge is marked `loose: true` when it rests on a Protobuf file name alone or on the JVM path convention.

## Where to call it

1. **Fast pass** (`src/ingest/facts.ts`, after `plugin.scan`): if the text contains any word of
   `BRIDGE_TRIGGERS[m]` for a mechanism `m` in `config.parser.bridges`,
   `facts.bridge = extractBridgeKeys({ path, lang, text, imports: facts.imports }, config.parser.bridges)`
   (store it only when one of the two lists is non-empty). The call is safe without the sweep too:
   it returns quickly for a file with nothing in it, except that a JVM file is always swept once for
   its classes.
2. **`.proto` files** are claimed by no plug-in and need nothing: `linkBridges` derives their keys
   from the path. `protoProvides(path)` is exported for anyone who wants them explicitly.
3. **Analysis** (`src/analysis`, next to symbol linking, before `aggregateEdges`):
   `raw.push(...bridgeRawEdges(linkBridges(files)))` with `files` = all `FileFacts`.
   `bridgeRawEdges` folds to one `RawEdge`-shaped object per file pair (`kind: 'bridge'`, `mechanism`,
   `count` = number of keys, `confidence` 1, or its third argument for pairs linked only loosely).
   `linkBridges(files).length` is the `bridges` counter of the analysis stats.
4. **Optional, instead of the Protobuf half of step 1:** `protoConsumes({ path, lang, imports })`
   needs no text, so it can run at analysis time over `FileFacts.imports`. This avoids the one way
   bridge keys depend on a file's *path* rather than its content (see the cache note below).

**Cache note.** Facts are cached by blob oid, but three keys depend on the path: a Protobuf import
written relative to the file (`./gen/foo_pb`), the key of a checked-in stub, and a Kotlin file's
facade class (`FooKt`). Two files with identical bytes in different folders would share them. Step 4
removes the first two; the third only matters for identical Kotlin files with top-level `external fun`.

`mangleJni(className, method, argSignature?)` and `demangleJni(symbol)` are exported for tooltips
and tests; they round-trip.

## Known misses

From the plan:

- **Names built at runtime**: a class path or method name assembled from pieces, passed through a
  function parameter, or produced by a macro (`JNI_METHOD(Bar, load)`, Chromium's generated JNI headers).
- **Reflection**: Java calling into classes by string, or native code using `GetObjectClass` and
  then `GetMethodID` — there is no class name to key on.
- **Generated code that is gitignored**: a stub that is not in the repo cannot be linked *through*;
  the Protobuf bridge therefore keys on the import alone and goes straight to the `.proto`.

From this implementation:

- **Go** stubs are matched by naming convention only (`…/userpb`, or an alias `userpb "…"`); the Go
  package path comes from `go_package` inside the `.proto`, which is not read. A package named
  after its directory (`…/api/user/v1` imported as `userv1`) is not linked.
- **Java outer classes** are recognised by suffix. With `java_multiple_files = true`, or an outer
  class that has no `OuterClass` / `Proto` suffix, an import names only the message and nothing links.
- **Per-platform implementations** of the same native method (`linux/x.c`, `windows/x.c`) are two
  providers: no edge, by the ambiguity rule.
- **Scala 3 without braces**: nested classes are not tracked (top-level ones are). Scala `@native`
  methods are not consumers. Rust `#[no_mangle] fn Java_…` is not a provider.
- **Kotlin `@JvmName`** on an `external fun` is ignored (the method keeps its Kotlin name in the key).
- `.proto` → `.proto` imports are not edges: `.proto` files are not parsed.
