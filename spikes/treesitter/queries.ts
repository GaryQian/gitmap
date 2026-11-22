// Hand-written tags-style queries (definitions + call-site references by identifier).
// Modelled on the upstream tags.scm files, trimmed to what starmap needs.

const JS_COMMON = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(method_definition name: (property_identifier) @name) @definition.method
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
(new_expression constructor: (identifier) @name) @reference.class
`;

const TS = JS_COMMON + `
(class_declaration name: (type_identifier) @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.type
(abstract_method_signature name: (property_identifier) @name) @definition.method
`;

const JS = JS_COMMON + `
(class_declaration name: (identifier) @name) @definition.class
`;

const PYTHON = `
(class_definition name: (identifier) @name) @definition.class
(function_definition name: (identifier) @name) @definition.function
(call function: (identifier) @name) @reference.call
(call function: (attribute attribute: (identifier) @name)) @reference.call
`;

const C_COMMON = `
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(struct_specifier name: (type_identifier) @name body: (_)) @definition.class
(enum_specifier name: (type_identifier) @name) @definition.type
(type_definition declarator: (type_identifier) @name) @definition.type
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
`;

const CPP = C_COMMON + `
(function_definition declarator: (function_declarator declarator: [(field_identifier) (qualified_identifier) (destructor_name) (operator_name)] @name)) @definition.function
(field_declaration declarator: (function_declarator declarator: (field_identifier) @name)) @definition.method
(class_specifier name: (type_identifier) @name body: (_)) @definition.class
(alias_declaration name: (type_identifier) @name) @definition.type
(namespace_definition name: (namespace_identifier) @name) @definition.module
(call_expression function: (qualified_identifier name: (identifier) @name)) @reference.call
(call_expression function: (template_function name: (identifier) @name)) @reference.call
(call_expression function: (field_expression field: (template_method name: (field_identifier) @name))) @reference.call
`;

const DART = `
(class_definition name: (identifier) @name) @definition.class
(mixin_declaration (identifier) @name) @definition.class
(extension_declaration name: (identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.type
(type_alias (type_identifier) @name) @definition.type
(function_signature name: (identifier) @name) @definition.function
(getter_signature name: (identifier) @name) @definition.method
(setter_signature name: (identifier) @name) @definition.method
(constructor_signature name: (identifier) @name) @definition.method
(_ (identifier) @name . (selector (argument_part))) @reference.call
(_ (selector (unconditional_assignable_selector (identifier) @name)) . (selector (argument_part))) @reference.call
(new_expression (type_identifier) @name) @reference.class
`;

const JAVA = `
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.type
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.method
(method_invocation name: (identifier) @name) @reference.call
(object_creation_expression type: (type_identifier) @name) @reference.class
`;

const RUST = `
(struct_item name: (type_identifier) @name) @definition.class
(enum_item name: (type_identifier) @name) @definition.class
(trait_item name: (type_identifier) @name) @definition.interface
(function_item name: (identifier) @name) @definition.function
(type_item name: (type_identifier) @name) @definition.type
(mod_item name: (identifier) @name) @definition.module
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
(call_expression function: (scoped_identifier name: (identifier) @name)) @reference.call
(macro_invocation macro: (identifier) @name) @reference.call
`;

export const QUERIES: Record<string, string> = {
  typescript: TS, tsx: TS, javascript: JS, python: PYTHON, c: C_COMMON, cpp: CPP, dart: DART, java: JAVA, rust: RUST,
};
