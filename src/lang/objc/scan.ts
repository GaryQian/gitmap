// Fast-pass scanner for Objective-C sources (PLAN.md §6.3). No syntax tree. `#import` and `#include`
// come from the C-family scanner; this adds `@import Module;` and the class and protocol names a file
// declares. `@class Foo;` is a forward declaration, not an import, and is left alone.
import type { ScanResult } from '../../contracts/lang';
import { blankComments, scanIncludes } from '../cfamily';

/** ImportSpec.kind of `@import Module.Submodule;`; the spec is the dotted module path. */
export const MODULE_IMPORT = 'module';

export function scanObjc(text: string): ScanResult {
  const result = scanIncludes(text);
  if (text.indexOf('@') < 0) return result;
  // Both patterns are anchored to a line start, which a string literal cannot contain.
  const clean = blankComments(text);
  const moduleImport = /^[ \t]*@import[ \t]+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[ \t]*;/gm;
  let m: RegExpExecArray | null;
  while ((m = moduleImport.exec(clean))) result.imports.push({ spec: m[1], kind: MODULE_IMPORT });

  // `@interface Name`, `@interface Name (Category)`, `@implementation Name`, `@protocol Name`.
  // `@protocol A, B;` only promises that the names exist somewhere.
  const declaration = /^[ \t]*@(?:interface|implementation|protocol)[ \t]+([A-Za-z_]\w*)[ \t]*([;,]?)/gm;
  const classes = new Set<string>();
  while ((m = declaration.exec(clean))) if (!m[2]) classes.add(m[1]);
  if (classes.size) result.decls = { ...result.decls, classes: [...classes] };
  return result;
}
