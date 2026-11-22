// Slow-pass query for PHP (PLAN.md §6.3), in the tags.scm convention of contracts/lang.ts, written
// against the `php` grammar (the one that also parses the HTML around `<?php … ?>`).
//
// A qualified name (`\App\Models\Order`) is a `qualified_name` whose direct `name` child is its last
// segment; the leading segments sit one level down, in `namespace_name`. Every pattern that accepts a
// class or function name therefore takes either a bare `name` or that last segment.
export const PHP_QUERY = `
; ---- definitions ----
(class_declaration name: (name) @name) @definition.class
(interface_declaration name: (name) @name) @definition.interface
(trait_declaration name: (name) @name) @definition.trait
(enum_declaration name: (name) @name) @definition.enum
(function_definition name: (name) @name) @definition.function

(class_declaration name: (name) @container
  body: (declaration_list (method_declaration name: (name) @name) @definition.method))
(interface_declaration name: (name) @container
  body: (declaration_list (method_declaration name: (name) @name) @definition.method))
(trait_declaration name: (name) @container
  body: (declaration_list (method_declaration name: (name) @name) @definition.method))
(enum_declaration name: (name) @container
  body: (enum_declaration_list (method_declaration name: (name) @name) @definition.method))
(anonymous_class
  (declaration_list (method_declaration name: (name) @name) @definition.method))

; ---- calls ----
; helper(), \\App\\Support\\helper()
(function_call_expression function: [(name) @name (qualified_name (name) @name)]) @reference.call
; $x->run(), $x?->run()
(member_call_expression name: (name) @name) @reference.call
(nullsafe_member_call_expression name: (name) @name) @reference.call
; Foo::make(), \\App\\Foo::make(): the class is the qualifier
(scoped_call_expression
  scope: [(name) @qualifier (qualified_name (name) @qualifier)]
  name: (name) @name) @reference.call
; self::make(), static::make(), parent::make(), $class::make()
(scoped_call_expression scope: [(relative_scope) (variable_name)] name: (name) @name) @reference.call

; ---- types ----
; \`new self\` and a \`static\` return type come through as names too; no definition has such a name,
; so the linker drops them.
; new Foo, new \\App\\Foo()
(object_creation_expression [(name) @name (qualified_name (name) @name)]) @reference.type
; parameter, return, property and catch types, inside unions and nullables too
(named_type [(name) @name (qualified_name (name) @name)]) @reference.type
; $x instanceof Foo
(binary_expression operator: "instanceof" right: [(name) @name (qualified_name (name) @name)]) @reference.type
; #[Route('/orders')]
(attribute [(name) @name (qualified_name (name) @name)]) @reference.type
; Foo::class, Foo::LIMIT: the class, not the constant
(class_constant_access_expression . [(name) @name (qualified_name (name) @name)]) @reference.reference

; ---- inheritance: extends, implements and trait use ----
; One match per listed name, so the reference capture sits on the name itself (written first, so it
; also comes first in capture order) rather than on the whole clause.
(base_clause (name) @reference.inherit @name)
(base_clause (qualified_name (name) @name) @reference.inherit)
(class_interface_clause (name) @reference.inherit @name)
(class_interface_clause (qualified_name (name) @name) @reference.inherit)
(use_declaration (name) @reference.inherit @name)
(use_declaration (qualified_name (name) @name) @reference.inherit)
`;
