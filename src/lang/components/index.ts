// Vue, Svelte and Astro plug-ins (PLAN.md §6.4). A component file is a container: its script
// block(s) — for Astro, the frontmatter — go through the TS/JS scanner and resolver, its style blocks
// through the stylesheet scanner and resolver. No grammar handles the script blocks through the TS
// query, so the slow pass is `extractSymbols` (./symbols.ts).
import { config } from '../../config';
import type { ImportSpec, LanguagePlugin, ScanResult } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { isLocalSpec, scanStyles, styleSyntax } from '../css';
import { scanImports } from '../ts';
import { splitComponent, type ComponentKind } from './blocks';
import { componentResolver } from './resolve';
import { extractComponentSymbols } from './symbols';

export { splitComponent, type ComponentKind, type ComponentParts } from './blocks';
export { componentResolver } from './resolve';
export { extractComponentSymbols } from './symbols';

/**
 * Imports of a component file. Kinds: the TS/JS kinds for script imports, the stylesheet kinds
 * ('css-import', 'css-use', 'css-forward', 'css-url') for style blocks, and 'src' for a block pulled
 * from another file (`<script src>`, `<style src>`, Vue `<template src>`).
 */
export function scanComponent(text: string, kind: ComponentKind): ScanResult {
  const parts = splitComponent(text, kind);
  const imports: ImportSpec[] = [];
  for (const s of parts.scripts) for (const imp of scanImports(s.text).imports) imports.push(imp);
  for (const s of parts.styles) for (const imp of scanStyles(s.text, styleSyntax(s.lang))) imports.push(imp);
  for (const src of parts.srcs) {
    const spec = src.trim();
    if (isLocalSpec(spec)) imports.push({ spec, kind: 'src' });
  }
  return { imports };
}

const plugin = (id: ComponentKind, name: string): LanguagePlugin => ({
  id,
  name,
  extensions: [id],
  color: languageColor(id, config.visual),
  scan: (text) => scanComponent(text, id),
  extractSymbols: (text, path) => extractComponentSymbols(text, path, id),
  createResolver: componentResolver,
});

export default [plugin('vue', 'Vue'), plugin('svelte', 'Svelte'), plugin('astro', 'Astro')];
