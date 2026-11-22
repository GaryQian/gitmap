// Slow-pass query for Rust, in the tags.scm convention of contracts/lang.ts. Every pattern is
// written so that one node gets one definition or reference capture: functions are listed by where
// they sit (file or module level, impl, trait) instead of once for every `function_item`.

/** `impl` target types whose last name becomes the methods' container: Foo, Foo<T>, a::Foo, a::Foo<T>, &Foo. */
const IMPL_TYPE = `[
    (type_identifier) @container
    (generic_type type: (type_identifier) @container)
    (scoped_type_identifier name: (type_identifier) @container)
    (generic_type type: (scoped_type_identifier name: (type_identifier) @container))
    (reference_type type: (type_identifier) @container)
  ]`;

/** Trait names in `impl Trait for X` and in a supertrait list. */
const TRAIT_NAME = `[
    (type_identifier) @name
    (generic_type type: (type_identifier) @name)
    (scoped_type_identifier name: (type_identifier) @name)
    (generic_type type: (scoped_type_identifier name: (type_identifier) @name))
  ]`;

export const RUST_QUERY = `
; ---- definitions ----
(source_file (function_item name: (identifier) @name) @definition.function)
(mod_item body: (declaration_list (function_item name: (identifier) @name) @definition.function))

(impl_item
  type: ${IMPL_TYPE}
  body: (declaration_list (function_item name: (identifier) @name) @definition.method))

(trait_item
  name: (type_identifier) @container
  body: (declaration_list
    [(function_item name: (identifier) @name) (function_signature_item name: (identifier) @name)] @definition.method))

(struct_item name: (type_identifier) @name) @definition.struct
(union_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.trait
(type_item name: (type_identifier) @name) @definition.type
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.constant
(macro_definition name: (identifier) @name) @definition.macro
; inline modules only: a "mod x;" declaration is an import, and that module is defined by its own file
(mod_item name: (identifier) @name body: (declaration_list)) @definition.module

; ---- calls ----
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (generic_function function: (identifier) @name)) @reference.call

; a::f(), a::b::f(), Type::f(): the qualifier is the segment in front of the name
(call_expression
  function: (scoped_identifier
    path: [(identifier) @qualifier (scoped_identifier name: (identifier) @qualifier)]
    name: (identifier) @name)) @reference.call
(call_expression
  function: (generic_function function: (scoped_identifier
    path: [(identifier) @qualifier (scoped_identifier name: (identifier) @qualifier)]
    name: (identifier) @name))) @reference.call

; crate::f(), super::f(), Vec::<T>::new(), <T as Trait>::f(): no plain-identifier qualifier
(call_expression
  function: (scoped_identifier
    path: [(crate) (super) (self) (generic_type) (bracketed_type) (metavariable)]
    name: (identifier) @name)) @reference.call

; x.method(), x.method::<T>()
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
(call_expression function: (generic_function function: (field_expression field: (field_identifier) @name))) @reference.call

; name!(…), a::name!(…)
(macro_invocation macro: (identifier) @name) @reference.call
(macro_invocation macro: (scoped_identifier name: (identifier) @name)) @reference.call

; ---- types ----
((type_identifier) @name) @reference.type

; Type::Variant, Type::CONST, Type::new — the type in front of an associated item
((scoped_identifier path: (identifier) @name) @reference.type
  (#match? @name "^[A-Z]"))

; ---- implemented traits and supertraits ----
(impl_item trait: ${TRAIT_NAME}) @reference.inherit
(trait_item bounds: (trait_bounds ${TRAIT_NAME})) @reference.inherit
`;
