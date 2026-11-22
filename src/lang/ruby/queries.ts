// Slow-pass query for tree-sitter-ruby, in the tags.scm capture convention (contracts/lang.ts).
//
// Definition patterns are written so that no definition matches two of them: a query cannot say
// "a method that is not directly inside a class", so each place a definition can sit gets its own
// pattern — the top level, a class or module body (with the owner as @container), `class << self`,
// an argument of `private def …`, and a block (`included do … end`, `Class.new do … end`). A
// definition anywhere else (inside an `if`, a `begin`) is not captured.
//
// Reference patterns do overlap where the kinds differ: a superclass or mixin is captured as
// @reference.inherit and, being a constant, as @reference.type too; `include Foo` is also a call.
// The `@_mixin` capture only feeds the predicate that tells `include` from other calls.

/** A method definition of either form, capturing its name. */
const METHOD = '[(method name: (_) @name) (singleton_method name: (_) @name)]';
/** Definitions that sit directly in a body, with the capture each one gets. */
const MEMBERS: [pattern: string, capture: string][] = [
  ['(class name: (constant) @name)', 'definition.class'],
  ['(module name: (constant) @name)', 'definition.module'],
  ['(assignment left: (constant) @name)', 'definition.constant'],
];

const lines: string[] = [];

// Top level. A `def` there is a function in all but name.
lines.push(`(program ${METHOD} @definition.function)`);
for (const [pattern, capture] of MEMBERS) lines.push(`(program ${pattern} @${capture})`);

// Directly inside a class or module, which becomes the container.
for (const owner of ['class', 'module']) {
  const inOwner = (inner: string): string => `(${owner} name: (_) @container body: (body_statement ${inner}))`;
  lines.push(inOwner(`${METHOD} @definition.method`));
  lines.push(inOwner(`(call arguments: (argument_list ${METHOD} @definition.method))`)); // private def x
  lines.push(inOwner(`(singleton_class body: (body_statement ${METHOD} @definition.method))`)); // class << self
  for (const [pattern, capture] of MEMBERS) lines.push(inOwner(`${pattern} @${capture}`));
}

// `class A::B` anywhere: the written scope is the container.
lines.push('(class name: (scope_resolution scope: (_) @container name: (_) @name)) @definition.class');
lines.push('(module name: (scope_resolution scope: (_) @container name: (_) @name)) @definition.module');

// Inside a block.
for (const inBlock of [
  (inner: string): string => `(do_block body: (body_statement ${inner}))`,
  (inner: string): string => `(block body: (block_body ${inner}))`,
]) {
  lines.push(inBlock(`${METHOD} @definition.method`));
  for (const [pattern, capture] of MEMBERS.slice(0, 2)) lines.push(inBlock(`${pattern} @${capture}`));
}

lines.push(
  // Calls. `Foo.bar` and `A::Foo.bar` carry the constant as qualifier. Receiverless calls are the
  // noisy majority in Ruby (`puts`, `attr_reader`, DSL words); they are captured and left to the
  // linker. A bare word with no arguments is an identifier in this grammar, not a call, and is not
  // captured: it cannot be told from a local variable. Calls on literals are core methods: skipped.
  '(call receiver: (constant) @qualifier method: (identifier) @name) @reference.call',
  '(call receiver: (scope_resolution name: (constant) @qualifier) method: (identifier) @name) @reference.call',
  '(call receiver: [(identifier) (instance_variable) (class_variable) (global_variable) (self) (call) (element_reference) (parenthesized_statements)] method: (identifier) @name) @reference.call',
  '(call !receiver method: (identifier) @name) @reference.call',

  // Constants: every one, once, so `A::B` is a reference to A and one to B, neither qualified. That
  // includes the name in `class Foo`, a reference from the file to itself. Keeping those out needs
  // "a constant whose parent has no `name` field"; `(_ !name (constant))` says it, but tree-sitter
  // skips a wildcard root when it matches and the negation with it (checked on web-tree-sitter 0.27).
  '(constant) @name @reference.type',

  // Superclasses and mixins.
  '(superclass (constant) @name) @reference.inherit',
  '(superclass (scope_resolution name: (constant) @name)) @reference.inherit',
  '(call !receiver method: (identifier) @_mixin arguments: (argument_list [(constant) @name (scope_resolution name: (constant) @name)]) (#any-of? @_mixin "include" "extend" "prepend")) @reference.inherit',
);

export const RUBY_QUERY = lines.join('\n');
