// What a worker keeps between history tasks: the opened repository (pack indexes, object and page
// caches), the commit-graph, and the path table of the tree differ.
import type { TaskContext } from '../contracts/compute';
import type { RepoAccess } from '../contracts/git';
import { openGitRepo, parseTag, T_COMMIT, T_TAG, type GitRepository } from '../git';
import { parseCommitHeader } from './commit';
import { CommitGraph } from './commitGraph';
import { PathTable } from './diff';
import type { FrontierEntry, HistoryUnavailable } from './types';

const CACHE_KEY = 'history.repo';

export class HistoryRepo {
  readonly paths = new PathTable();
  private graph: CommitGraph | null | undefined;

  constructor(readonly access: RepoAccess, readonly git: GitRepository) {}

  /** The commit-graph, loaded on first use. Not used on a shallow clone, where git ignores it too. */
  commitGraph(): CommitGraph | null {
    if (this.graph === undefined) this.graph = this.git.isShallow() ? null : CommitGraph.open(this.git.fs);
    return this.graph;
  }

  /** Read one commit for the planner. Null when it is not on disk (or is not a commit). */
  readCommit(oid: string, useGraph: boolean): FrontierEntry | null {
    if (useGraph) {
      const g = this.commitGraph()?.lookup(oid);
      if (g) return { oid, date: g.date, tree: g.tree, parents: g.parents, ident: null, authorTime: 0 };
    }
    const obj = this.git.odb.readHex(oid);
    if (!obj || obj.type !== T_COMMIT) return null;
    const c = parseCommitHeader(obj.data);
    return c ? { oid, date: c.commitTime, tree: c.tree, parents: c.parents, ident: c.ident, authorTime: c.authorTime } : null;
  }

  /** Follow annotated tags to the commit they name. Null when the chain does not end at a commit. */
  peelToCommit(oid: string): string | null {
    for (let depth = 0; depth < 8; depth++) {
      const obj = this.git.odb.readHex(oid);
      if (!obj) return null;
      if (obj.type === T_COMMIT) return oid;
      if (obj.type !== T_TAG) return null;
      oid = parseTag(obj.data).object;
    }
    return null;
  }
}

/** The worker's HistoryRepo for the pool's current repo, or the reason there is no history to read. */
export async function historyRepoFor(ctx: TaskContext): Promise<HistoryRepo | HistoryUnavailable> {
  const access = await ctx.repo();
  if (!access) return { reason: 'no-repo', message: 'No repository is open.' };
  if (!access.git) return { reason: 'no-git', message: 'This folder has no .git directory, so there is no history to read.' };
  const held = ctx.cache.get(CACHE_KEY) as HistoryRepo | undefined;
  if (held && held.access === access) return held;
  const git = openGitRepo(access.git);
  if (git.configEntries().some((e) => e.section === 'extensions' && e.key === 'objectformat' && e.value.toLowerCase() === 'sha256')) {
    return { reason: 'unsupported', message: 'SHA-256 repositories are not supported.' };
  }
  const repo = new HistoryRepo(access, git);
  ctx.cache.set(CACHE_KEY, repo);
  return repo;
}

export function isUnavailable(v: HistoryRepo | HistoryUnavailable): v is HistoryUnavailable {
  return !(v instanceof HistoryRepo);
}
