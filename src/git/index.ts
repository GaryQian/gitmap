// Public surface of src/git (browser-safe). Package 1C owns this folder. Node-only code lives in ./node.ts.
//
//   openRepoAccess(locator)  → RepoAccess { name, tree, git }      (access.ts)
//   openGitRepo(access.git)  → GitRepository: head, index, objects (repo.ts)
//   parseGitIndex(bytes)     → IndexEntry[]                         (gitIndex.ts)
//   parseCommit / parseTree / treeEntries / parseTag               (objects.ts)
//   ObjectDb, PackIndex, applyDelta                                (odb.ts)
//   hex, text and SHA-1 helpers                                    (bytes.ts)
export { parseGitIndex, UnsupportedIndexError, type UnsupportedIndexReason } from './gitIndex';
export {
  openGitRepo, parseGitConfig, normalizeRemoteUrl,
  type GitRepoOptions, type GitRepository, type GitConfigEntry,
} from './repo';
export {
  openRepoAccess, BrowserGitFs, FsaWorkingTree, MapWorkingTree,
  type OpenRepoOptions,
} from './access';
export {
  ObjectDb, PackIndex, applyDelta, typeName, T_COMMIT, T_TREE, T_BLOB, T_TAG,
  type RawObject, type ObjectDbOptions, type ObjectDbStats,
} from './odb';
export {
  parseCommit, parseTag, parseTree, treeEntries,
  MODE_TREE, MODE_FILE, MODE_EXEC, MODE_SYMLINK, MODE_GITLINK,
  type ParsedCommit, type ParsedTag, type TreeEntry, type GitPerson,
} from './objects';
export { toHex, hexToBytes, asciiHexToBytes, isOid, decodeText, sha1, hashObject } from './bytes';
export { PagedFile, PageCache, type IoStats } from './paged';
