// Slow-pass queries for TypeScript and JavaScript (PLAN.md §6.3), in the tags.scm style described in
// src/contracts/lang.ts. Ported from spikes/treesitter/queries.ts and extended.
//
// .ts/.mts/.cts use the `typescript` grammar and .tsx the `tsx` grammar. JavaScript also uses `tsx`:
// it is a superset that reads JSX and Flow-style annotations, and on react's Flow-typed .js files it
// parsed 34% faster with 70% fewer files in error than the `javascript` grammar
// (spikes/treesitter/RESULTS.md).
//
// Conventions beyond the contract, understood by the slow-pass runner (src/ingest/syntax/extract.ts):
// @local marks a declaration that is private to its file unless an @export capture names it.
import type { SyntaxSpec } from '../../contracts/lang';
import { extname } from '../../shared';

const DEFINITIONS = `
(function_declaration name: (identifier) @name) @definition.function @local
(generator_function_declaration name: (identifier) @name) @definition.function @local
(function_signature name: (identifier) @name) @definition.function @local
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function @local
(assignment_expression left: (member_expression property: (property_identifier) @name) right: [(arrow_function) (function_expression)] (#not-eq? @name "exports")) @definition.function
(assignment_expression right: (function_expression name: (identifier) @name) @definition.function)
(class_declaration name: (type_identifier) @name) @definition.class @local
(abstract_class_declaration name: (type_identifier) @name) @definition.class @local
(interface_declaration name: (type_identifier) @name) @definition.interface @local
(type_alias_declaration name: (type_identifier) @name) @definition.type @local
(enum_declaration name: (identifier) @name) @definition.enum @local
(internal_module name: (identifier) @name) @definition.module @local
(method_definition name: (property_identifier) @name) @definition.method
(abstract_method_signature name: (property_identifier) @name) @definition.method
(method_signature name: (property_identifier) @name) @definition.method
(public_field_definition name: (property_identifier) @name value: [(arrow_function) (function_expression)]) @definition.method
(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @definition.constant))
`;

// Names a file exports: ES exports, ambient declarations, and the CommonJS forms.
const EXPORTS = `
(export_statement declaration: (_ name: (_) @export))
(export_statement declaration: (_ (variable_declarator name: (identifier) @export)))
(export_statement (export_clause (export_specifier name: (identifier) @export)))
(export_statement value: (identifier) @export)
(ambient_declaration (_ name: (_) @export))
(ambient_declaration (_ (variable_declarator name: (identifier) @export)))
(assignment_expression
  left: (member_expression object: (identifier) @_obj property: (property_identifier) @_prop)
  right: [(identifier) @export (object [(shorthand_property_identifier) @export (pair value: (identifier) @export)])]
  (#eq? @_obj "module") (#eq? @_prop "exports"))
(assignment_expression
  left: (member_expression object: (identifier) @_obj)
  right: (identifier) @export
  (#eq? @_obj "exports"))
(assignment_expression
  left: (member_expression object: (member_expression object: (identifier) @_obj property: (property_identifier) @_prop))
  right: (identifier) @export
  (#eq? @_obj "module") (#eq? @_prop "exports"))
`;

// Base classes come before the general type pattern: the first pattern to name a node decides its kind.
const REFERENCES = `
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (member_expression object: (identifier) @qualifier property: (property_identifier) @name)) @reference.call
(call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
(new_expression constructor: (identifier) @name) @reference.type
(new_expression constructor: (member_expression object: (identifier) @qualifier property: (property_identifier) @name)) @reference.type
(extends_clause value: (identifier) @name) @reference.inherit
(extends_clause value: (member_expression object: (identifier) @qualifier property: (property_identifier) @name)) @reference.inherit
(implements_clause (type_identifier) @name) @reference.inherit
(implements_clause (generic_type name: (type_identifier) @name)) @reference.inherit
(extends_type_clause type: (type_identifier) @name) @reference.inherit
(extends_type_clause type: (generic_type name: (type_identifier) @name)) @reference.inherit
(nested_type_identifier module: (identifier) @qualifier name: (type_identifier) @name) @reference.type
(type_identifier) @name @reference.type
`;

// A component used as a JSX element is a call to it. Lower-case names are host elements.
const JSX = `
(jsx_opening_element name: (identifier) @name (#match? @name "^[A-Z]")) @reference.call
(jsx_self_closing_element name: (identifier) @name (#match? @name "^[A-Z]")) @reference.call
(jsx_opening_element name: (member_expression object: (identifier) @qualifier property: (property_identifier) @name)) @reference.call
(jsx_self_closing_element name: (member_expression object: (identifier) @qualifier property: (property_identifier) @name)) @reference.call
`;

export const TYPESCRIPT_QUERY = DEFINITIONS + EXPORTS + REFERENCES;
export const TSX_QUERY = TYPESCRIPT_QUERY + JSX;

const queries = { typescript: TYPESCRIPT_QUERY, tsx: TSX_QUERY };

export const tsSyntax: SyntaxSpec = {
  grammar: (path) => (extname(path) === 'tsx' ? 'tsx' : 'typescript'),
  queries,
};

export const jsSyntax: SyntaxSpec = {
  grammar: () => 'tsx',
  queries,
};
