// Slow-pass query for Swift (PLAN.md §6.3), in the tags.scm convention of contracts/lang.ts. Written
// against tree-sitter-swift as shipped in public/grammars, whose node names are unusual: class,
// struct, enum, actor and extension are all `class_declaration`, told apart by `declaration_kind`;
// a call's callee is the first child of `call_expression`, with no field; a type in a type position
// is a `user_type` of one or more `type_identifier`s.
//
// Several patterns may match one @name; the slow pass keeps the earliest, so the specific pattern
// comes before the general one (method before function, inheritance before plain type use).
//
// Definitions: class, actor (as class), struct, enum, protocol (as interface), typealias, functions,
// and methods with their type as @container — for an extension, the extended type, so `Foo.bar()`
// finds a method that an extension adds to Foo. `init` is a method named "init". An extension is not
// a definition: its target is captured as a type reference by the `user_type` pattern.
// `private` and `fileprivate` declarations and functions nested in a body are @local.
//
// References: calls by name (`f()`, `x.f()` with a plain-identifier receiver as @qualifier),
// constructor calls (`Foo(…)`: a callee that does not start with a lower-case letter) and type uses
// as @reference.type, static access (`Foo.shared`, `Kind.case`) as a type reference to the receiver,
// and inheritance or conformance clauses as @reference.inherit.

const PRIVATE = '(#match? @local "^(private|fileprivate)")';
/** The declared name of a type declaration, or the last component of an extension's target. */
const TYPE_NAME = '[(type_identifier) @container (user_type (type_identifier) @container .)]';

export const SWIFT_QUERY = `
; ---- definitions ----
(class_declaration declaration_kind: "class" name: (type_identifier) @name) @definition.class
(class_declaration declaration_kind: "actor" name: (type_identifier) @name) @definition.class
(class_declaration declaration_kind: "struct" name: (type_identifier) @name) @definition.struct
(class_declaration declaration_kind: "enum" name: (type_identifier) @name) @definition.enum
(protocol_declaration name: (type_identifier) @name) @definition.interface
(typealias_declaration name: (type_identifier) @name) @definition.type

(class_declaration
  name: ${TYPE_NAME}
  body: (_ (function_declaration name: (simple_identifier) @name) @definition.method))
(class_declaration
  name: ${TYPE_NAME}
  body: (_ (init_declaration name: "init" @name) @definition.method))
(protocol_declaration
  name: (type_identifier) @container
  body: (protocol_body (protocol_function_declaration name: (simple_identifier) @name) @definition.method))
(protocol_declaration
  name: (type_identifier) @container
  body: (protocol_body (init_declaration name: "init" @name) @definition.method))
(function_declaration name: (simple_identifier) @name) @definition.function

; ---- private to the file ----
(function_declaration (modifiers (visibility_modifier) @local) name: (simple_identifier) @name ${PRIVATE})
(class_declaration (modifiers (visibility_modifier) @local) name: (type_identifier) @name ${PRIVATE})
(protocol_declaration (modifiers (visibility_modifier) @local) name: (type_identifier) @name ${PRIVATE})
(typealias_declaration (modifiers (visibility_modifier) @local) name: (type_identifier) @name ${PRIVATE})
(class_declaration
  (modifiers (visibility_modifier) @local)
  declaration_kind: "extension"
  body: (class_body (function_declaration name: (simple_identifier) @name))
  ${PRIVATE})
(statements (function_declaration name: (simple_identifier) @name) @local)

; ---- calls ----
(call_expression . (simple_identifier) @name (#match? @name "^[a-z_]")) @reference.call
(call_expression . (simple_identifier) @name (#not-match? @name "^[a-z_]")) @reference.type
(call_expression . (navigation_expression
  target: (simple_identifier)? @qualifier
  suffix: (navigation_suffix suffix: (simple_identifier) @name))) @reference.call
; The grammar parses \`!f(x)\`, \`a + f(x)\` and \`a * f(x)\` as a call of the whole operator expression.
(call_expression . (prefix_expression operation: (bang) target: (simple_identifier) @name)) @reference.call
(call_expression . (additive_expression rhs: (simple_identifier) @name)) @reference.call
(call_expression . (multiplicative_expression rhs: (simple_identifier) @name)) @reference.call
; \`[Foo]()\` and \`[Key: Foo]()\`
(call_expression . (array_literal . element: (simple_identifier) @name .)) @reference.type
(call_expression . (dictionary_literal value: (simple_identifier) @name)) @reference.type

; ---- types ----
(navigation_expression target: (simple_identifier) @name (#match? @name "^[A-Z]")) @reference.type
(inheritance_specifier inherits_from: (user_type (type_identifier) @name)) @reference.inherit
; Every other type position, extension targets included. Lower-case names here are attributes
; (\`@testable\`, \`@escaping\`), never types of the repo.
(user_type (type_identifier) @name (#not-match? @name "^[a-z]")) @reference.type
(key_path_expression (type_identifier) @name) @reference.type
`;
