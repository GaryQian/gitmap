// Small questions the shell asks a folder itself, where the pipeline's answer does not say enough.
import type { RepoLocator } from '../../contracts/git';
import type { RepoSource } from '../../contracts/pipeline';

function locatorOf(source: RepoSource): RepoLocator | null {
  return source.kind === 'directory' ? source.locator : source.kind === 'snapshot' ? source.locator ?? null : null;
}

/**
 * True when the folder's `.git` is a file, not a directory: a linked worktree or a submodule, whose
 * history lives in another folder. Never rejects; false when it cannot tell.
 */
export async function gitIsFile(source: RepoSource): Promise<boolean> {
  const locator = locatorOf(source);
  try {
    if (locator?.kind === 'fsa') {
      await locator.root.getFileHandle('.git');
      return true;
    }
    if (locator?.kind === 'files') return locator.files.some((f) => f.path === '.git');
    if (locator?.kind === 'memory') return '.git' in locator.files;
  } catch {
    // no such file (TypeMismatchError when it is a directory, NotFoundError when it is absent)
  }
  return false;
}
