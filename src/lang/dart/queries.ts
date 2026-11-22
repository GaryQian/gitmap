// Slow-pass query for Dart (PLAN.md §6.3), in the tags.scm convention of contracts/lang.ts.
//
// Notes on the grammar (tree-sitter-dart as shipped in public/grammars), each checked with runQuery:
// - A call is not one node. `foo(1)` is an `identifier` followed by a sibling `selector` holding an
//   `argument_part`; `a.b(1)` puts a `selector` holding `.b` between them. The patterns below
//   therefore match sibling sequences and capture the identifier itself as the reference.
// - Dart has no `new` at most call sites, so `Foo(1)` and `foo(1)` parse alike. They are told apart
//   by the language's naming rule (types are UpperCamelCase, everything else lowerCamelCase): an
//   upper-case callee is a constructor call and counts as a type reference.
// - A function or method is a signature node followed by a sibling `function_body`; the signature
//   is captured as the definition.
// - A type in `extends` / `with` / `implements` / `on` also matches the general type pattern. The
//   inheritance patterns come first, so a runner that keeps the first pattern per name sees `inherit`.
// - Names that start with `_` are private to their library. They are marked with @local, the
//   optional capture the slow-pass runner reads as `exported: false`.

/** Named members of a class-like body: methods, getters and named constructors. */
const MEMBERS = `[
    (method_signature [
      (function_signature name: (identifier) @name)
      (getter_signature name: (identifier) @name)
      (factory_constructor_signature (identifier) . "." . (identifier) @name)
    ])
    (declaration [
      (function_signature name: (identifier) @name)
      (getter_signature name: (identifier) @name)
      (constructor_signature (identifier) . "." . (identifier) @name)
      (constant_constructor_signature (identifier) . "." . (identifier) @name)
      (redirecting_factory_constructor_signature (identifier) . "." . (identifier) @name)
    ])
  ] @definition.method`;

const UPPER = '"^[_$]*[A-Z]"';
const LOWER = '"^[_$]*[a-z]"';

export const DART_QUERY = `
; ---- definitions ----
(class_definition name: (identifier) @name) @definition.class
(class_definition (mixin_application_class . (identifier) @name)) @definition.class
(mixin_declaration (identifier) @name) @definition.trait
(extension_declaration name: (identifier) @name) @definition.class
(extension_type_declaration name: (identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.enum
(type_alias (type_identifier) @name . (type_parameters)? . "=") @definition.type
(type_alias (type_identifier) @name . (type_parameters)? . (formal_parameter_list)) @definition.type
(program (function_signature name: (identifier) @name) @definition.function)
(program (getter_signature name: (identifier) @name) @definition.function)

(class_definition name: (identifier) @container body: (class_body ${MEMBERS}))
(mixin_declaration (identifier) @container (class_body ${MEMBERS}))
(extension_declaration name: (identifier) @container body: (extension_body ${MEMBERS}))
(extension_type_declaration name: (identifier) @container body: (class_body ${MEMBERS}))
(enum_declaration name: (identifier) @container body: (enum_body ${MEMBERS}))

; library-private names
([
  (class_definition name: (identifier) @name)
  (mixin_application_class . (identifier) @name)
  (mixin_declaration (identifier) @name)
  (extension_declaration name: (identifier) @name)
  (extension_type_declaration name: (identifier) @name)
  (enum_declaration name: (identifier) @name)
  (type_alias (type_identifier) @name . [(type_parameters) "=" (formal_parameter_list)])
  (function_signature name: (identifier) @name)
  (getter_signature name: (identifier) @name)
  (constructor_signature (identifier) . "." . (identifier) @name)
  (constant_constructor_signature (identifier) . "." . (identifier) @name)
  (factory_constructor_signature (identifier) . "." . (identifier) @name)
  (redirecting_factory_constructor_signature (identifier) . "." . (identifier) @name)
] @local (#match? @name "^_"))

; ---- calls ----
; foo(…), foo<T>(…)
((identifier) @name @reference.call . (selector (argument_part)) (#match? @name ${LOWER}))
; x.foo(…), x?.foo(…), a.b.foo(…); the qualifier is captured when it is a plain identifier
((identifier)? @qualifier
  . (selector [(unconditional_assignable_selector (identifier) @name @reference.call) (conditional_assignable_selector (identifier) @name @reference.call)])
  . (selector (argument_part))
  (#match? @name ${LOWER}))
; super.foo(…)
((unconditional_assignable_selector (identifier) @name @reference.call) . (selector (argument_part)))
; x..foo(…)
(cascade_section (cascade_selector (identifier) @name @reference.call) . (argument_part))

; ---- inheritance: extends, with, implements, mixin … on ----
(superclass (type_identifier) @name @reference.inherit)
(mixins (type_identifier) @name @reference.inherit)
(interfaces (type_identifier) @name @reference.inherit)
(mixin_application (type_identifier) @name @reference.inherit)
(mixin_declaration (type_identifier) @name @reference.inherit)

; ---- types ----
(type_identifier) @name @reference.type
; Foo(…), Foo.named(…), Foo.constant
((identifier) @name @reference.type . (selector) (#match? @name ${UPPER}))
; prefix.Foo(…), prefix.Foo.named(…)
(selector (unconditional_assignable_selector (identifier) @name @reference.type) (#match? @name ${UPPER}))
`;
