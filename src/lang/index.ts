// Language plug-in registry. Lead-owned. Plug-ins are discovered, never listed: each
// src/lang/<id>/index.ts default-exports a LanguagePlugin or an array of them.
import type { LanguagePlugin } from '../contracts/lang';
import { basename, extname } from '../shared';

const modules = import.meta.glob<{ default: LanguagePlugin | LanguagePlugin[] }>('./*/index.ts', { eager: true });

export const plugins: LanguagePlugin[] = Object.keys(modules)
  .sort()
  .flatMap((key) => {
    const d = modules[key].default;
    return Array.isArray(d) ? d : d ? [d] : [];
  });

const byId = new Map<string, LanguagePlugin>();
const byExt = new Map<string, LanguagePlugin>();
const byName = new Map<string, LanguagePlugin>();
for (const p of plugins) {
  if (byId.has(p.id)) throw new Error(`duplicate language plug-in id: ${p.id}`);
  byId.set(p.id, p);
  for (const e of p.extensions) if (!byExt.has(e)) byExt.set(e, p);
  for (const n of p.filenames ?? []) if (!byName.has(n)) byName.set(n, p);
}

export function pluginById(id: string): LanguagePlugin | undefined {
  return byId.get(id);
}

/** The plug-in that claims a path, by exact basename first and extension second. */
export function pluginForPath(path: string): LanguagePlugin | undefined {
  return byName.get(basename(path)) ?? byExt.get(extname(path));
}

/** True when some plug-in wants this file's text kept as a manifest (LanguagePlugin.manifests). */
export function isManifestFile(path: string): boolean {
  const base = basename(path);
  for (const p of plugins) {
    for (const m of p.manifests ?? []) {
      if (m === base || (m.startsWith('*.') && base.endsWith(m.slice(1)))) return true;
    }
  }
  return false;
}
