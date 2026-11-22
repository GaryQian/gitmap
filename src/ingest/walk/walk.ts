// The folder walk: every file under a WorkingTree that git would not ignore. It serves plain folders
// with no .git, the optional untracked-files setting, and trees built from a dropped file list.
import type { GitFs, WorkingTree } from '../../contracts/git';
import { parseGitConfig } from '../../git';
import { chainIgnores, compileIgnore, type IgnoreRules } from './ignore';

/** Directory listings, .gitignore reads and stat calls kept in flight. */
const DEFAULT_CONCURRENCY = 32;
/** Files (and, separately, directories) after which the walk gives up. */
const DEFAULT_MAX_FILES = 1_000_000;

export interface WalkOptions {
  /**
   * The repo's git directory, when it has one. Adds the patterns of .git/info/exclude and takes
   * case sensitivity from core.ignorecase.
   */
  git?: GitFs | null;
  /** Match ignore patterns case-insensitively. Default: core.ignorecase when `git` is given, else false. */
  ignoreCase?: boolean;
  /** Asked for each directory that is not ignored; true leaves it out with everything below it. */
  skipDir?(path: string, name: string): boolean;
  /** Asked for each file that is not ignored; false leaves it out, before any stat call. */
  include?(path: string): boolean;
  /**
   * Leave out a subfolder that holds its own .git, as git does for nested repositories and
   * submodules. Default false: a plain folder of several repos shows them all.
   */
  skipNestedRepos?: boolean;
  /** False when the caller does not need sizes: no stat calls are made and every size is −1. */
  sizes?: boolean;
  concurrency?: number;
  /** Hard cap on files found (and on directories entered); the walk rejects with WalkLimitError beyond it. */
  maxFiles?: number;
  signal?: AbortSignal;
}

export interface WalkedFile { path: string; size: number }

/** The folder holds more files than the walk is allowed to collect. */
export class WalkLimitError extends Error {
  constructor(readonly limit: number, what: 'files' | 'folders') {
    super(`This folder holds more than ${limit.toLocaleString('en-US')} ${what} after its ignore rules were applied, so the walk was stopped. Open a smaller folder, or add a .gitignore that leaves out generated and downloaded files.`);
    this.name = 'WalkLimitError';
  }
}

const decoder = new TextDecoder();

function readGitText(git: GitFs, path: string): string | null {
  try {
    const size = git.size(path);
    return size < 0 ? null : decoder.decode(git.readAt(path, 0, size));
  } catch { return null; }
}

/** core.ignorecase of .git/config: git matches ignore patterns case-insensitively when it is set. */
export function gitIgnoresCase(git: GitFs): boolean {
  let on = false;
  for (const e of parseGitConfig(readGitText(git, 'config') ?? '')) {
    if (e.section === 'core' && e.key === 'ignorecase') on = /^(true|yes|on|1)$/i.test(e.value.trim());
  }
  return on;
}

/** Run `task` over `items` with at most `limit` in flight. `items` may grow while the pool runs. Rejects on the first failure. */
function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let next = 0;
    let active = 0;
    let failed = false;
    const pump = (): void => {
      if (failed) return;
      while (active < limit && next < items.length) {
        active++;
        task(items[next++]).then(
          () => { active--; pump(); },
          (e) => { failed = true; reject(e); },
        );
      }
      if (active === 0 && next >= items.length) resolve();
    };
    pump();
  });
}

/**
 * List every file under `tree` that git would not ignore, sorted by path. Honours each directory's
 * .gitignore (read before the directory's entries are judged, so an ignored directory is never
 * listed) and .git/info/exclude when `opts.git` is given. Never enters a `.git`.
 *
 * Known difference from git: ignore files outside the repo (core.excludesFile) are not read.
 */
export async function walkTree(tree: WorkingTree, opts: WalkOptions = {}): Promise<WalkedFile[]> {
  const { signal, git = null } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const ignoreCase = opts.ignoreCase ?? (git ? gitIgnoresCase(git) : false);
  signal?.throwIfAborted();

  const rootChain: IgnoreRules[] = [];
  const excludeText = git ? readGitText(git, 'info/exclude') : null;
  if (excludeText) {
    const rules = compileIgnore(excludeText, '', { ignoreCase });
    if (rules.size) rootChain.push(rules);
  }

  interface Dir { path: string; chain: IgnoreRules[] }
  const dirs: Dir[] = [{ path: '', chain: rootChain }];
  const paths: string[] = [];

  await pool(dirs, concurrency, async (dir) => {
    signal?.throwIfAborted();
    const items = await tree.list(dir.path);
    signal?.throwIfAborted();
    if (dir.path !== '' && opts.skipNestedRepos && items.some((e) => e.name === '.git')) return;
    const prefix = dir.path === '' ? '' : `${dir.path}/`;
    let chain = dir.chain;
    if (items.some((e) => e.kind === 'file' && e.name === '.gitignore')) {
      const bytes = await tree.read(`${prefix}.gitignore`);
      signal?.throwIfAborted();
      const rules = bytes ? compileIgnore(decoder.decode(bytes), dir.path, { ignoreCase }) : null;
      if (rules?.size) chain = [rules, ...chain];
    }
    for (const item of items) {
      if (item.name === '.git') continue;
      const path = prefix + item.name;
      const isDir = item.kind === 'dir';
      if (chain.length && chainIgnores(chain, path, prefix.length, isDir)) continue;
      if (isDir) {
        if (opts.skipDir?.(path, item.name)) continue;
        if (dirs.length > maxFiles) throw new WalkLimitError(maxFiles, 'folders');
        dirs.push({ path, chain });
      } else {
        if (opts.include && !opts.include(path)) continue;
        if (paths.length >= maxFiles) throw new WalkLimitError(maxFiles, 'files');
        paths.push(path);
      }
    }
  });

  paths.sort();
  if (opts.sizes === false) return paths.map((path) => ({ path, size: -1 }));

  const sizes = new Array<number>(paths.length).fill(-1);
  await pool(paths.map((_, i) => i), concurrency, async (i) => {
    signal?.throwIfAborted();
    const stat = await tree.stat(paths[i]);
    if (stat) sizes[i] = stat.size;
  });
  signal?.throwIfAborted();
  const out: WalkedFile[] = [];
  for (let i = 0; i < paths.length; i++) if (sizes[i] >= 0) out.push({ path: paths[i], size: sizes[i] }); // −1: vanished or unreadable
  return out;
}
