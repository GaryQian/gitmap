// The manifest (PLAN.md §6.2): which files are on the map and how the parse reads each one.
// From .git/index when there is one, otherwise from a walk of the folder.
import picomatch from 'picomatch';
import type { Config } from '../config';
import type { GitFs, GitRepo, RepoAccess } from '../contracts/git';
import type { Manifest, ManifestEntry } from '../contracts/ingest';
import { openGitRepo } from '../git';
import { pluginForPath } from '../lang';
import { extname } from '../shared';

export type OpenGit = (fs: GitFs) => GitRepo;

const MODE_TYPE_MASK = 0o170000;
const MODE_SYMLINK = 0o120000;
const MODE_SUBMODULE = 0o160000;
/** Directory listings and stat calls kept in flight during a folder walk. */
const WALK_CONCURRENCY = 32;

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

/** Tracked files from the git index. Null when the index holds nothing. Throws when it cannot be read. */
function fromIndex(repo: RepoAccess, git: GitRepo, config: Config): Manifest | null {
  const rules = rulesFor(config);
  const tracked = git.indexEntries();
  if (tracked.length === 0) return null;
  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();
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

/**
 * Every file under the folder, for a plain folder or an unreadable index. Skips .git, node_modules
 * and dot-directories and applies config.parser.exclude; it does not read .gitignore (package 3Q).
 */
async function fromWalk(repo: RepoAccess, config: Config, reason: string): Promise<Manifest> {
  const rules = rulesFor(config);
  const paths: string[] = [];
  let excluded = 0;
  let pending = [''];
  while (pending.length) {
    const dirs = pending.splice(0, WALK_CONCURRENCY);
    const listings = await Promise.all(dirs.map((d) => repo.tree.list(d)));
    const found: string[] = [];
    listings.forEach((items, k) => {
      for (const item of items) {
        const path = dirs[k] ? `${dirs[k]}/${item.name}` : item.name;
        if (item.kind === 'dir') {
          if (item.name !== 'node_modules' && !item.name.startsWith('.')) found.push(path);
        } else if (rules.excluded(path)) excluded++;
        else paths.push(path);
      }
    });
    pending = pending.concat(found);
  }
  const entries: ManifestEntry[] = [];
  for (let i = 0; i < paths.length; i += WALK_CONCURRENCY) {
    const slice = paths.slice(i, i + WALK_CONCURRENCY);
    const stats = await Promise.all(slice.map((p) => repo.tree.stat(p)));
    stats.forEach((stat, k) => {
      if (!stat) return; // vanished or unreadable
      const path = slice[k];
      entries.push({ path, oid: '', bytes: stat.size, lang: pluginForPath(path)?.id ?? null, read: rules.unread(path, stat.size) ? 'none' : 'tree', packOffset: -1 });
    });
  }
  return finish(repo, entries, excluded, { source: 'folder', headOid: null, indexChecksum: null, remoteUrl: null, historyUnavailable: reason });
}

/**
 * Build the manifest. `openGit` is injectable so tests can supply a fake GitRepo; it defaults to
 * openGitRepo from src/git.
 */
export async function buildManifest(repo: RepoAccess, config: Config, openGit: OpenGit = openGitRepo): Promise<Manifest> {
  let reason = 'This folder is not a git repository.';
  if (repo.git) {
    try {
      const manifest = fromIndex(repo, openGit(repo.git), config);
      if (manifest) return manifest;
      reason = 'The git index lists no files.';
    } catch (e) {
      reason = `The git index could not be read (${e instanceof Error ? e.message : String(e)}).`;
    }
  }
  return fromWalk(repo, config, reason);
}
