// HTML plug-in: `<script src>`, `<link href>`, `<img src>`, the imports of inline scripts and of
// inline `<style>` blocks. Fast pass only (PLAN.md §6.3). The tag finder in ./markup.ts is also what
// the Vue / Svelte / Astro plug-ins use.
import { config } from '../../config';
import type { FileFacts, ImportSpec, LanguagePlugin, RepoIndex, ResolvedImport, Resolver, ScanResult } from '../../contracts/lang';
import { dirname, joinPath, languageColor } from '../../shared';
import { cleanSpec, isLocalSpec, probeModule, resolveRootRelative, scanStyles, styleResolver } from '../css';
import { scanImports, tsResolver } from '../ts';
import { isScriptCode, scanMarkup } from './markup';

export { isScriptCode, scanMarkup, type MarkupBlock } from './markup';

const TAGS = new Set(['script', 'link', 'img', 'style']);

/**
 * Kinds: 'script' (`<script src>`), 'link' (`<link href>`), 'img' (`<img src>`); the TS/JS kinds for
 * imports inside an inline script; the stylesheet kinds for an inline `<style>`.
 */
export function scanHtml(text: string): ScanResult {
  const imports: ImportSpec[] = [];
  const push = (value: string | undefined, kind: string): void => {
    const spec = value?.trim();
    if (spec && isLocalSpec(spec)) imports.push({ spec, kind });
  };
  for (const b of scanMarkup(text, TAGS, true)) {
    if (b.tag === 'script') {
      if (b.attrs.src) push(b.attrs.src, 'script');
      else if (b.body && isScriptCode(b.attrs)) for (const imp of scanImports(b.body).imports) imports.push(imp);
    } else if (b.tag === 'style') {
      for (const imp of scanStyles(b.body)) imports.push(imp);
    } else push(b.tag === 'link' ? b.attrs.href : b.attrs.src, b.tag);
  }
  return { imports };
}

function htmlResolver(index: RepoIndex): Resolver {
  const ts = tsResolver(index);
  const styles = styleResolver(index);
  const exact = (p: string): string | null => (index.has(p) ? p : null);
  /** A script URL names the file itself, or the build output of a TS source (`app.js` for `app.ts`). */
  const script = (p: string): string | null => exact(p) ?? probeModule(index, p);
  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      if (imp.kind.startsWith('css-')) return styles.resolve(file, imp);
      const spec = cleanSpec(imp.spec);
      const asset = imp.kind === 'link' || imp.kind === 'img';
      // An import statement inside an inline script: the TS/JS rules, plus root-relative URLs.
      if (!asset && imp.kind !== 'script' && !spec.startsWith('/')) return ts.resolve(file, imp);
      if (!isLocalSpec(spec)) return [];
      const dir = dirname(file.path);
      let hit: ResolvedImport | null = null;
      if (spec.startsWith('/')) hit = resolveRootRelative(index, dir, spec, asset ? exact : script);
      else { // a URL relative to the page
        const p = joinPath(dir, spec);
        const found = p ? (asset ? exact(p) : script(p)) : null;
        if (found) hit = { path: found, confidence: 1 };
      }
      return hit && hit.path !== file.path ? [hit] : [];
    },
  };
}

const html: LanguagePlugin = {
  id: 'html',
  name: 'HTML',
  extensions: ['html', 'htm'],
  color: languageColor('html', config.visual),
  scan: (text) => scanHtml(text),
  createResolver: htmlResolver,
};

export default html;
