// Slow-pass query for Java, in the tags.scm convention of contracts/lang.ts (SyntaxSpec).
//
// Each method and constructor is matched by exactly one pattern, which also names its enclosing
// type as @container. Each method call is one @reference.call, with @qualifier when the receiver is
// a plain identifier (`Util.slug(x)`, `order.total()`). Every type name is a @reference.type, so a
// supertype counts twice: once as @reference.inherit and once as a type reference.
export const JAVA_QUERY = `
; ---- type definitions ----
(class_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(annotation_type_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum

; ---- methods and constructors, by the kind of body they sit in ----
(class_declaration name: (identifier) @container
  body: (class_body [
    (method_declaration name: (identifier) @name)
    (constructor_declaration name: (identifier) @name)
  ] @definition.method))
(record_declaration name: (identifier) @container
  body: (class_body [
    (method_declaration name: (identifier) @name)
    (constructor_declaration name: (identifier) @name)
    (compact_constructor_declaration name: (identifier) @name)
  ] @definition.method))
(interface_declaration name: (identifier) @container
  body: (interface_body (method_declaration name: (identifier) @name) @definition.method))
(enum_declaration name: (identifier) @container
  body: (enum_body (enum_body_declarations [
    (method_declaration name: (identifier) @name)
    (constructor_declaration name: (identifier) @name)
  ] @definition.method)))
; anonymous classes and enum constants with a body have no name to give as container
(object_creation_expression (class_body (method_declaration name: (identifier) @name) @definition.method))
(enum_constant body: (class_body (method_declaration name: (identifier) @name) @definition.method))

; ---- calls ----
(method_invocation object: (identifier)? @qualifier name: (identifier) @name) @reference.call

; ---- type references: every type name (new X, fields, parameters, generics, casts), annotations,
; and an upper-case receiver such as Status.ACTIVE or Util.slug(x) ----
((type_identifier) @name) @reference.type
(marker_annotation name: (identifier) @name) @reference.type
(annotation name: (identifier) @name) @reference.type
(field_access object: (identifier) @name (#match? @name "^[A-Z]")) @reference.type
(method_invocation object: (identifier) @name (#match? @name "^[A-Z]")) @reference.type

; ---- extends / implements ----
(superclass [
  (type_identifier) @name
  (generic_type (type_identifier) @name)
  (scoped_type_identifier (type_identifier) @name .)
]) @reference.inherit
(super_interfaces (type_list [
  (type_identifier) @name
  (generic_type (type_identifier) @name)
  (scoped_type_identifier (type_identifier) @name .)
])) @reference.inherit
(extends_interfaces (type_list [
  (type_identifier) @name
  (generic_type (type_identifier) @name)
  (scoped_type_identifier (type_identifier) @name .)
])) @reference.inherit
`;
