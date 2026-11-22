// Slow-pass queries for C and C++ (PLAN.md §6.3), in the tags.scm style described in
// src/contracts/lang.ts. Ported from spikes/treesitter/queries.ts and extended. Headers are parsed
// as C++, like the rest of this plug-in treats them.
//
// A prototype counts as a definition of its function, as it did in the spike: a header is where a
// C API is visible. The symbol linker pairs headers with their sources (package 2C).
//
// Conventions beyond the contract, understood by the slow-pass runner (src/ingest/syntax/extract.ts):
// @local marks a `static` function as private to its file, and @export takes that back for
// `static inline`, which in a header is shared with every file that includes it. @ignore drops
// what looks like a prototype inside a function body, where `Foo f(x);` declares a variable.
import type { SyntaxSpec } from '../../contracts/lang';
import { isObjcHeader } from './objcScan';

// Compiling a query costs time per pattern and per level of nesting, most of all for patterns
// rooted at a node with many kinds of children, and the C++ grammar is large (the first version of
// this file took over a second per worker to compile). Hence one wrapper level in most places, two
// only for plain function definitions, and @ignore instead of listing where a prototype may stand.

/** A declarator as written, or behind a pointer or reference wrapper: `T f()`, `T *f()`, `T &f()`. */
const wrapped = (d: string): string => `[${d} (_ ${d})]`;
/** The same, and behind two wrappers: `T **f()`. */
const wrappedTwice = (d: string): string => `[${d} (_ ${d}) (_ (_ ${d}))]`;

const fn = (capture: string): string => `(function_declarator declarator: (identifier) ${capture})`;

const C_DEFINITIONS = `
(compound_statement (declaration declarator: ${wrapped(fn('@name'))}) @ignore)
(function_definition declarator: ${wrappedTwice(fn('@name'))}) @definition.function
(declaration declarator: ${wrapped(fn('@name'))}) @definition.function
(struct_specifier name: (type_identifier) @name body: (_)) @definition.struct
(union_specifier name: (type_identifier) @name body: (_)) @definition.struct
(enum_specifier name: (type_identifier) @name body: (_)) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.type
(preproc_function_def name: (identifier) @name) @definition.macro

(function_definition (storage_class_specifier) @local declarator: ${wrapped(fn('@name'))} (#eq? @local "static"))
(declaration (storage_class_specifier) @local declarator: ${fn('@name')} (#eq? @local "static"))
(function_definition (storage_class_specifier) @_inline declarator: ${wrapped(fn('@export'))} (#eq? @_inline "inline"))
`;

const C_REFERENCES = `
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression argument: (identifier) @qualifier field: (field_identifier) @name)) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
(type_identifier) @name @reference.type
`;

export const C_QUERY = C_DEFINITIONS + C_REFERENCES;

/** The class or namespace a qualified name is defined in: `Widget::draw`, `Stack<T>::push`. */
const SCOPE = '[(namespace_identifier) @container (template_type name: (type_identifier) @container)]';
const member = '(function_declarator declarator: (field_identifier) @name)';
const qualified = [
  `(qualified_identifier scope: ${SCOPE} name: (identifier) @name)`,
  `(qualified_identifier name: (qualified_identifier scope: ${SCOPE} name: (identifier) @name))`,
].map((q) => `(function_definition declarator: ${wrapped(`(function_declarator declarator: ${q})`)}) @definition.method`).join('\n');

// Members come before the C patterns: the first pattern to name a node decides its kind.
const CPP_DEFINITIONS = `
(field_declaration declarator: ${wrapped(member)}) @definition.method
(function_definition declarator: ${wrapped(member)}) @definition.method
(field_declaration_list (declaration declarator: ${fn('@name')}) @definition.method)
(field_declaration_list (function_definition declarator: ${fn('@name')}) @definition.method)
${qualified}
(class_specifier name: (type_identifier) @name body: (_)) @definition.class
(namespace_definition name: (namespace_identifier) @name) @definition.module
(alias_declaration name: (type_identifier) @name) @definition.type
`;

// Base classes come before the general type pattern, for the same reason.
const CPP_REFERENCES = `
(call_expression function: (qualified_identifier scope: (namespace_identifier) @qualifier name: (identifier) @name)) @reference.call
(call_expression function: (qualified_identifier name: (qualified_identifier scope: (namespace_identifier) @qualifier name: (identifier) @name))) @reference.call
(call_expression function: (template_function name: (identifier) @name)) @reference.call
(call_expression function: (qualified_identifier scope: (namespace_identifier) @qualifier name: (template_function name: (identifier) @name))) @reference.call
(call_expression function: (field_expression field: (template_method name: (field_identifier) @name))) @reference.call
(base_class_clause (type_identifier) @name) @reference.inherit
(base_class_clause (template_type name: (type_identifier) @name)) @reference.inherit
(base_class_clause (qualified_identifier scope: (namespace_identifier) @qualifier name: (type_identifier) @name)) @reference.inherit
(base_class_clause (qualified_identifier scope: (namespace_identifier) @qualifier name: (template_type name: (type_identifier) @name))) @reference.inherit
(qualified_identifier scope: (namespace_identifier) @qualifier name: (type_identifier) @name) @reference.type
`;

export const CPP_QUERY = CPP_DEFINITIONS + C_DEFINITIONS + CPP_REFERENCES + C_REFERENCES;

export const cSyntax: SyntaxSpec = {
  grammar: () => 'c',
  queries: { c: C_QUERY },
};

/**
 * `grammar` also takes the file's text, which the contract does not pass yet (SyntaxSpec.grammar sees
 * the path only). Given the text of an Objective-C header it answers '', the slow-pass runner's name
 * for "no grammar: use the plug-in's extractSymbols", because the C++ grammar cannot read
 * `@interface`. With the path alone every file of the plug-in is C++, as before.
 */
export const cppSyntax: SyntaxSpec & { grammar(path: string, text?: string): string | null } = {
  grammar: (path, text) => (text !== undefined && isObjcHeader(text, path) ? '' : 'cpp'),
  queries: { cpp: CPP_QUERY },
};
