// Scene-module discovery: every src/render/<feature>/module.ts that default-exports a factory.
// No registry to edit (src/contracts/README.md rule 3).
import type { SceneModule, SceneModuleFactory } from './types';

const found = import.meta.glob<{ default?: SceneModuleFactory }>('../*/module.ts', { eager: true });

/** One fresh instance of every discovered module, in hook order. */
export function createModules(): SceneModule[] {
  const modules: SceneModule[] = [];
  for (const path of Object.keys(found).sort()) {
    const factory = found[path].default;
    if (typeof factory !== 'function') {
      console.warn(`[render] ${path} has no default-exported scene-module factory; skipped`);
      continue;
    }
    modules.push(factory());
  }
  return modules.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
