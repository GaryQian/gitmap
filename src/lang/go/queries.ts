// Slow-pass query for Go (PLAN.md §6.3), in the tags.scm convention of contracts/lang.ts. Written
// against tree-sitter-go as shipped in public/grammars (method_elem, type_elem, var_spec_list).
//
// Definitions are the package-level ones: functions, methods (receiver type as @container),
// interface methods (interface as @container), types, constants and variables. Whether a name is
// exported is Go's capitalisation rule on @name; the runner derives it.
// References are calls (`f()`, `pkg.F()` and `x.M()` with the operand as @qualifier), type uses
// (`T`, `pkg.T` with the package as @qualifier) and embedded types as @reference.inherit.

/** A type name in a type position, plain or package-qualified. `kind` is the reference capture. */
const typeName = (kind: string): string =>
  `[(type_identifier) @name (qualified_type package: (package_identifier) @qualifier name: (type_identifier) @name)] @reference.${kind}`;

const T = typeName('type');
const EMBEDDED = typeName('inherit');

/** Type positions that hold a type name directly: the `type:` field of these nodes. */
const TYPED_NODES = [
  'parameter_declaration', 'variadic_parameter_declaration', 'var_spec', 'const_spec', 'type_spec', 'type_alias',
  'composite_literal', 'type_assertion_expression', 'type_conversion_expression', 'generic_type', 'type_case',
];

/**
 * A declaration that stands alone (`type T …`) is captured whole, so its doc comment is the node
 * before it; inside `type ( … )` each spec is captured. A group of exactly one spec matches both.
 */
const typeDefinition = (spec: string, kind: string): string => `
(source_file (type_declaration . (${spec}) .) @definition.${kind})
(source_file (type_declaration "(" (${spec}) @definition.${kind}))`;

const OTHER_TYPES = '[(type_identifier) (qualified_type) (pointer_type) (array_type) (slice_type) (map_type) (channel_type) (function_type) (generic_type) (parenthesized_type)]';

export const GO_QUERY = `
; ---- definitions ----
(function_declaration name: (identifier) @name) @definition.function

(method_declaration
  receiver: (parameter_list (parameter_declaration type: [
    (type_identifier) @container
    (pointer_type (type_identifier) @container)
    (generic_type type: (type_identifier) @container)
    (pointer_type (generic_type type: (type_identifier) @container))
  ]))
  name: (field_identifier) @name) @definition.method

(type_spec
  name: (type_identifier) @container
  type: (interface_type (method_elem name: (field_identifier) @name) @definition.method))
${typeDefinition('type_spec name: (type_identifier) @name type: (struct_type)', 'struct')}
${typeDefinition('type_spec name: (type_identifier) @name type: (interface_type)', 'interface')}
${typeDefinition(`type_spec name: (type_identifier) @name type: ${OTHER_TYPES}`, 'type')}
${typeDefinition('type_alias name: (type_identifier) @name', 'type')}

; Only the first name of a const_spec carries the \`name\` field, so names are matched by position.
((source_file (const_declaration . (const_spec (identifier) @name) .) @definition.constant) (#not-eq? @name "_"))
((source_file (const_declaration "(" (const_spec (identifier) @name) @definition.constant)) (#not-eq? @name "_"))
((source_file (var_declaration (var_spec name: (identifier) @name)) @definition.variable) (#not-eq? @name "_"))
((source_file (var_declaration (var_spec_list (var_spec name: (identifier) @name) @definition.variable))) (#not-eq? @name "_"))

; ---- calls ----
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (selector_expression operand: (identifier) @qualifier field: (field_identifier) @name)) @reference.call
(call_expression function: (selector_expression
  operand: [(selector_expression) (call_expression) (index_expression) (parenthesized_expression) (type_assertion_expression)]
  field: (field_identifier) @name)) @reference.call

; ---- embedded types ----
(field_declaration !name type: ${EMBEDDED})
(interface_type (type_elem . ${EMBEDDED} .))

; ---- type references ----
${TYPED_NODES.map((node) => `(${node} type: ${T})`).join('\n')}
(field_declaration name: (field_identifier) . type: ${T})
(_ result: ${T})
(pointer_type ${T})
(parenthesized_type ${T})
(slice_type element: ${T})
(array_type element: ${T})
(implicit_length_array_type element: ${T})
(map_type key: ${T})
(map_type value: ${T})
(channel_type value: ${T})
(type_arguments (type_elem ${T}))
(type_constraint ${T})
(argument_list ${T})
`;
