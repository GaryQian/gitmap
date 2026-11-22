// Slow-pass query for the tree-sitter `c_sharp` grammar (PLAN.md §6.3), in the tags.scm convention of
// contracts/lang.ts. Patterns are exclusive: no definition or reference is matched by two of them.
// Type and base-type references put @name and the @reference capture on the identifier itself.

export const CSHARP_GRAMMAR = 'c_sharp';

export const CSHARP_QUERY = `
; ---- definitions ----
(class_declaration name: (identifier) @name) @definition.class
(struct_declaration name: (identifier) @name) @definition.struct
(interface_declaration name: (identifier) @name) @definition.interface
(record_declaration name: (identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.enum
(delegate_declaration name: (identifier) @name) @definition.type

; Methods and constructors, with the enclosing type as container.
(_ name: (identifier) @container
  body: (declaration_list (method_declaration name: (identifier) @name) @definition.method))
(_ name: (identifier) @container
  body: (declaration_list (constructor_declaration name: (identifier) @name) @definition.method))
; The same inside #if … #endif, where the type is no longer the direct parent.
([(preproc_if) (preproc_elif) (preproc_else)] (method_declaration name: (identifier) @name) @definition.method)
([(preproc_if) (preproc_elif) (preproc_else)] (constructor_declaration name: (identifier) @name) @definition.method)

; ---- calls ----
((invocation_expression function: (identifier) @name) @reference.call
  (#not-eq? @name "nameof"))
(invocation_expression function: (generic_name (identifier) @name)) @reference.call
(invocation_expression
  function: (member_access_expression
    expression: (identifier)? @qualifier
    name: (identifier) @name)) @reference.call
(invocation_expression
  function: (member_access_expression
    expression: (identifier)? @qualifier
    name: (generic_name (identifier) @name))) @reference.call
(invocation_expression
  function: (conditional_access_expression
    (member_binding_expression name: (identifier) @name))) @reference.call

; ---- type references ----
; Every 'type' field: variables, fields, parameters, properties, object creation, casts, typeof,
; patterns, catch, foreach, array and nullable element types.
(_ type: (identifier) @name @reference.type)
(_ type: (generic_name (identifier) @name @reference.type))
(_ type: (qualified_name name: (identifier) @name @reference.type))
(method_declaration returns: (identifier) @name @reference.type)
(method_declaration returns: (generic_name (identifier) @name @reference.type))
(type_argument_list (identifier) @name @reference.type)
(type_argument_list (generic_name (identifier) @name @reference.type))
(as_expression right: (identifier) @name @reference.type)
; Static access through a type name: Currency.Eur, Guard.NotNull(…). Capitalised receivers only.
((member_access_expression expression: (identifier) @name @reference.type)
  (#match? @name "^[A-Z]"))

; ---- base lists ----
(base_list (identifier) @name @reference.inherit)
(base_list (generic_name (identifier) @name @reference.inherit))
(base_list (qualified_name name: (identifier) @name @reference.inherit))
`;
