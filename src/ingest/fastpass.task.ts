// Pool task 'ingest.fastPass' (PLAN.md §6.3): one batch of manifest entries → one FileFacts each.
// Bytes come from the git object store for 'pack' entries (the GitRepo is opened once per worker and
// kept in ctx.cache) and from the working tree otherwise; a pack miss falls back to the tree.
//
// Protocol with runFastPass: a returned fact carries the entry's `oid` only when its bytes came from
// git, where content is guaranteed to match the oid. A working-tree read may differ from what is
// staged, so those facts come back with `oid: ''`; runFastPass restores the oid and keeps them out
// of the facts cache.
import { defineTask, type TaskDef } from '../contracts/compute';
import type { GitFs, GitRepo, RepoAccess } from '../contracts/git';
import type { ManifestEntry } from '../contracts/ingest';
import type { FileFacts } from '../contracts/lang';
import { openGitRepo } from '../git';
import { factsFromBytes, skippedFacts } from './facts';
import { unreadReason, type OpenGit } from './manifest';

export const FAST_PASS_TASK = 'ingest.fastPass';
export interface FastPassInput { entries: ManifestEntry[] }

const GIT_CACHE_KEY = 'ingest.gitRepo';
/** Working-tree reads kept in flight per worker (PLAN.md §6.3.1, item 5). */
const TREE_READS_IN_FLIGHT = 8;

/** The worker's GitRepo for this repo, opened on first use. Null when there is no usable .git. */
function gitFor(repo: RepoAccess, cache: Map<string, unknown>, openGit: OpenGit): GitRepo | null {
  if (!repo.git) return null;
  const held = cache.get(GIT_CACHE_KEY) as { fs: GitFs; git: GitRepo | null } | undefined;
  if (held && held.fs === repo.git) return held.git;
  let git: GitRepo | null = null;
  try { git = openGit(repo.git); } catch { /* every entry falls back to the working tree */ }
  cache.set(GIT_CACHE_KEY, { fs: repo.git, git });
  return git;
}

function readBlob(git: GitRepo, oid: string): Uint8Array | null {
  try {
    const obj = git.readObject(oid);
    return obj && obj.type === 'blob' ? obj.data : null;
  } catch { return null; }
}

/** `openGit` is injectable so tests can supply a fake GitRepo. */
export function createFastPassTask(openGit: OpenGit = openGitRepo): TaskDef<FastPassInput, FileFacts[]> {
  return defineTask<FastPassInput, FileFacts[]>({
    type: FAST_PASS_TASK,
    async run(input, ctx) {
      const repo = await ctx.repo();
      if (!repo) throw new Error(`${FAST_PASS_TASK}: no repo is set on the pool`);
      const { entries } = input;
      const out = new Array<FileFacts>(entries.length);
      const fromTree: number[] = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.read === 'none') { out[i] = skippedFacts(e, unreadReason(e, ctx.config)); continue; }
        const git = e.read === 'pack' ? gitFor(repo, ctx.cache, openGit) : null;
        const bytes = git ? readBlob(git, e.oid) : null;
        if (bytes) out[i] = factsFromBytes(e, bytes, ctx.config);
        else fromTree.push(i);
      }
      for (let k = 0; k < fromTree.length; k += TREE_READS_IN_FLIGHT) {
        const slice = fromTree.slice(k, k + TREE_READS_IN_FLIGHT);
        const reads = await Promise.all(slice.map((i) => repo.tree.read(entries[i].path).catch(() => null)));
        slice.forEach((i, j) => {
          const bytes = reads[j];
          const facts = bytes ? factsFromBytes(entries[i], bytes, ctx.config) : skippedFacts(entries[i], 'unreadable');
          facts.oid = ''; // not verified against the index (see the protocol note above)
          out[i] = facts;
        });
      }
      return out;
    },
  });
}

export default createFastPassTask();
