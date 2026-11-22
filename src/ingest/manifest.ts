// The manifest (PLAN.md §6.2): which files are on the map and how the parse reads each one.
// From .git/index when there is one, otherwise from a walk of the folder.
import picomatch from 'picomatch';
import type { Config } from '../config';
import type { GitFs, GitRepo, RepoAccess } from '../contracts/git';
import type { Manifest, ManifestEntry } from '../contracts/ingest';
import { openGitRepo } from '../git';
import { pluginForPath } from '../lang';
import { extname } from '../shared';
import { walkTree, type WalkedFile } from './walk';

export type OpenGit = (fs: GitFs) => GitRepo;

const MODE_TYPE_MASK = 0o170000;
const MODE_SYMLINK = 0o120000;
const MODE_SUBMODULE = 0o160000;

interface Rules {
  excluded(path: string): boolean;
  /** Files that are never opened: binary by extension, or over the size cap. */
  unread(path: string, bytes: number): boolean;
}

function rulesFor(config: Config): Rules {
  // Paths are always '/'-separated, whatever the platform.
  const excluded = picomatch(config.parser.exclude, { dot: true, windows: false });
  const binary = new Set(config.parser.binaryExtensions);
  return {
    excluded,
    unread: (path, bytes) => binary.has(extname(path)) || bytes > config.parser.maxFileBytes,
  };
}

/** Why a `read: 'none'` entry is not opened. */
export function unreadReason(entry: ManifestEntry, config: Config): 'binary' | 'too-large' {
  return config.parser.binaryExtensions.includes(extname(entry.path)) ? 'binary' : 'too-large';
}

const byPath = (a: ManifestEntry, b: ManifestEntry): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function finish(repo: RepoAccess, entries: ManifestEntry[], excluded: number, rest: Pick<Manifest, 'source' | 'headOid' | 'indexChecksum' | 'remoteUrl' | 'historyUnavailable'>): Manifest {
  entries.sort(byPath);
  let totalBytes = 0;
  for (const e of entries) totalBytes += e.bytes;
  const manifest: Manifest = { repoName: repo.name, source: rest.source, headOid: rest.headOid, indexChecksum: rest.indexChecksum, remoteUrl: rest.remoteUrl, entries, excluded, totalBytes };
  if (rest.historyUnavailable) manifest.historyUnavailable = rest.historyUnavailable;
  return manifest;
}

/**
 * Tracked files from the git index. Null when the index holds nothing. Throws when it cannot be read.
 * `seen` receives every path of the index, including the ones left off the map.
 */
function fromIndex(repo: RepoAccess, git: GitRepo, config: Config, seen = new Set<string>()): Manifest | null {
  const rules = rulesFor(config);
  const tracked = git.indexEntries();
  if (tracked.length === 0) return null;
  const entries: ManifestEntry[] = [];
  let excluded = 0;
  for (const t of tracked) {
    if (seen.has(t.path)) continue; // a conflicted path is listed once per stage
    seen.add(t.path);
    const type = t.mode & MODE_TYPE_MASK;
    if (type === MODE_SUBMODULE || type === MODE_SYMLINK || rules.excluded(t.path)) { excluded++; continue; }
    const lang = pluginForPath(t.path)?.id ?? null;
    let read: ManifestEntry['read'] = 'none';
    let packOffset = -1;
    if (!rules.unread(t.path, t.size)) {
      if (git.isPacked(t.oid)) { read = 'pack'; packOffset = git.packOffset(t.oid); } else read = 'tree';
    }
    entries.push({ path: t.path, oid: t.oid, bytes: t.size, lang, read, packOffset });
  }
  return finish(repo, entries, excluded, { source: 'git', headOid: git.head().oid, indexChecksum: git.indexChecksum(), remoteUrl: git.remoteUrl() });
}

/** An entry for a file found by the folder walk: no blob oid, read from the working tree. */
function walked(file: WalkedFile, rules: Rules): ManifestEntry {
  return { path: file.path, oid: '', bytes: file.size, lang: pluginForPath(file.path)?.id ?? null, read: rules.unread(file.path, file.size) ? 'none' : 'tree', packOffset: -1 };
}

/**
 * Every file under the folder that its .gitignore files do not ignore (src/ingest/walk), for a plain
 * folder or an unreadable index. Also skips .git, node_modules and dot-directories and applies
 * config.parser.exclude.
 */
async function fromWalk(repo: RepoAccess, config: Config, reason: string): Promise<Manifest> {
  const rules = rulesFor(config);
  let excluded = 0;
  const files = await walkTree(repo.tree, {
    git: repo.git,
    skipDir: (_path, name) => name === 'node_modules' || name.startsWith('.'),
    include: (path) => {
      if (!rules.excluded(path)) return true;
      excluded++;
      return false;
    },
  });
  return finish(repo, files.map((f) => walked(f, rules)), excluded, { source: 'folder', headOid: null, indexChecksum: null, remoteUrl: null, historyUnavailable: reason });
}

/**
 * config.parser.includeUntracked: add the files git would report as untracked, which are those the
 * walk finds that are neither in the index (`tracked`) nor ignored. A subfolder that is a
 * repository of its own is left out, as git leaves it.
 */
async function withUntracked(repo: RepoAccess, manifest: Manifest, tracked: Set<string>, config: Config): Promise<Manifest> {
  const rules = rulesFor(config);
  const files = await walkTree(repo.tree, { git: repo.git, skipNestedRepos: true, include: (path) => !tracked.has(path) && !rules.excluded(path) });
  return finish(repo, manifest.entries.concat(files.map((f) => walked(f, rules))), manifest.excluded, manifest);
}

/**
 * Build the manifest. `openGit` is injectable so tests can supply a fake GitRepo; it defaults to
 * openGitRepo from src/git.
 */
export async function buildManifest(repo: RepoAccess, config: Config, openGit: OpenGit = openGitRepo): Promise<Manifest> {
  let reason = 'This folder is not a git repository.';
  if (repo.git) {
    const tracked = new Set<string>();
    let manifest: Manifest | null = null;
    try {
      manifest = fromIndex(repo, openGit(repo.git), config, tracked);
      if (!manifest) reason = 'The git index lists no files.';
    } catch (e) {
      reason = `The git index could not be read (${e instanceof Error ? e.message : String(e)}).`;
    }
    if (manifest) return config.parser.includeUntracked ? withUntracked(repo, manifest, tracked, config) : manifest;
  }
  return fromWalk(repo, config, reason);
}
