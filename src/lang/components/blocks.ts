// Splits a single-file component into its parts: script blocks (for Astro, the frontmatter too),
// style blocks, `src` attributes that pull a block from another file, and what is left (the template).
import { isScriptCode, scanMarkup } from '../html';

export type ComponentKind = 'vue' | 'svelte' | 'astro';

export interface ComponentParts {
  /** Script texts with their offset in the file. */
  scripts: { text: string; offset: number }[];
  /** Style texts with their `lang` attribute. */
  styles: { text: string; lang: string | undefined }[];
  /** `<script src>`, `<style src>` and (Vue) `<template src>` values. */
  srcs: string[];
  /** The file with frontmatter, script blocks, style blocks and comments removed. Empty unless asked for. */
  template: string;
}

const TAGS = new Set(['script', 'style']);
const VUE_TAGS = new Set(['script', 'style', 'template']);

/** Astro frontmatter: the text between a leading `---` line and the next line starting with `---`. */
function frontmatter(text: string): { start: number; end: number; after: number } | null {
  const open = /^﻿?\s*---/.exec(text);
  if (!open) return null;
  const start = open[0].length;
  const close = text.indexOf('\n---', start);
  return close < 0 ? null : { start, end: close, after: close + 4 };
}

export function splitComponent(text: string, kind: ComponentKind, withTemplate = false): ComponentParts {
  const parts: ComponentParts = { scripts: [], styles: [], srcs: [], template: '' };
  let from = 0;
  if (kind === 'astro') {
    const fm = frontmatter(text);
    if (fm) {
      parts.scripts.push({ text: text.slice(fm.start, fm.end), offset: fm.start });
      from = fm.after;
    }
  }
  const markup = from ? text.slice(from) : text;
  let template = '';
  let kept = 0;
  for (const b of scanMarkup(markup, kind === 'vue' ? VUE_TAGS : TAGS)) {
    if (b.attrs.src) parts.srcs.push(b.attrs.src);
    if (b.tag === 'template') continue;
    if (b.tag === 'style') parts.styles.push({ text: b.body, lang: b.attrs.lang });
    else if (b.body && !b.attrs.src && isScriptCode(b.attrs)) parts.scripts.push({ text: b.body, offset: from + b.bodyStart });
    if (withTemplate) template += markup.slice(kept, b.start);
    kept = b.end;
  }
  if (withTemplate) parts.template = (template + markup.slice(kept)).replace(/<!--[\s\S]*?-->/g, '');
  return parts;
}
