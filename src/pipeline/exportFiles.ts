// Session.readFiles, for the package export (plan/DEMO-MODE.md §3): the bytes the map was built from.
// Where the folder is a git repo that is the committed blob, read by the id the map recorded, so it
// always matches; otherwise (a plain folder, an object that is gone) the file as it is on disk.
import type { RepoAccess } from '../contracts/git';
import { openGitRepo, type GitRepository } from '../git';
import type { PipelineDeps, PipelineState } from './core';

export type FileReader = (paths: string[]) => Promise<(Uint8Array | null)[]>;

export function createFileReader(deps: PipelineDeps, state: PipelineState): FileReader {
  let opened: Promise<{ repo: RepoAccess; git: GitRepository | null } | null> | null = null;
  const open = () => (opened ??= (async () => {
    const { source } = state;
    // a map shown from a file with its folder beside it never opened the repo: open it now
    const locator = source.kind === 'directory' || source.kind === 'snapshot' ? source.locator : undefined;
    const repo = state.repo ?? (locator ? await deps.openRepo(locator) : null);
    if (!repo) return null;
    let git: GitRepository | null = null;
    try { git = repo.git ? openGitRepo(repo.git) : null; } catch { /* a folder that is not a readable repo: the files on disk will do */ }
    return { repo, git };
  })());

  return async (paths) => {
    const at = await open();
    if (!at) throw new Error('There is no folder behind this map to read files from.');
    const files = deps.store.replica.table('file');
    return Promise.all(paths.map(async (path) => {
      const slot = files.slotOf(path);
      const oid = slot >= 0 ? files.cols.oid[slot] : '';
      if (at.git && oid) {
        try {
          const obj = at.git.readObject(oid);
          if (obj?.type === 'blob') return obj.data;
        } catch { /* fall through to the working tree */ }
      }
      try { return await at.repo.tree.read(path); } catch { return null; }
    }));
  };
}
