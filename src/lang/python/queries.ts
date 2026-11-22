// Slow-pass query for Python (PLAN.md §6.3), in the tags.scm style described in
// src/contracts/lang.ts. Ported from spikes/treesitter/queries.ts and extended.
//
// One convention beyond the contract, understood by the slow-pass runner (src/ingest/syntax/extract.ts):
// @doc is the docstring. A pattern with only @name and @doc adds it to the definition of that name.
import type { SyntaxSpec } from '../../contracts/lang';

// Methods come before the general function pattern: the first pattern to name a node decides its kind.
const DEFINITIONS = `
(class_definition name: (identifier) @name) @definition.class
(class_definition body: (block (function_definition name: (identifier) @name) @definition.method))
(class_definition body: (block (decorated_definition definition: (function_definition name: (identifier) @name) @definition.method)))
(function_definition name: (identifier) @name) @definition.function
(module (expression_statement (assignment left: (identifier) @name) @definition.constant) (#match? @name "^_?[A-Z][A-Z0-9_]*$"))

(function_definition name: (identifier) @name body: (block . (expression_statement (string) @doc)))
(class_definition name: (identifier) @name body: (block . (expression_statement (string) @doc)))
`;

const REFERENCES = `
(call function: (identifier) @name) @reference.call
(call function: (attribute object: (identifier) @qualifier attribute: (identifier) @name)) @reference.call
(call function: (attribute attribute: (identifier) @name)) @reference.call
(decorator (identifier) @name) @reference.call
(decorator (attribute object: (identifier) @qualifier attribute: (identifier) @name)) @reference.call
(class_definition superclasses: (argument_list (identifier) @name)) @reference.inherit
(class_definition superclasses: (argument_list (attribute object: (identifier) @qualifier attribute: (identifier) @name))) @reference.inherit
(type (identifier) @name) @reference.type
(type (attribute object: (identifier) @qualifier attribute: (identifier) @name)) @reference.type
(type (generic_type (identifier) @name)) @reference.type
`;

export const PYTHON_QUERY = DEFINITIONS + REFERENCES;

export const pythonSyntax: SyntaxSpec = {
  grammar: () => 'python',
  queries: { python: PYTHON_QUERY },
  // A leading underscore is private by convention; dunder names (__init__) are the language's own.
  exported: (name) => !name.startsWith('_') || /^__.+__$/.test(name),
};
