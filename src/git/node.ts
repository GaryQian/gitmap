// Node-only entry of src/git: never imported by browser code. Package 1C owns this folder.
import type { RepoAccess } from '../contracts/git';

/** Open a repo on the local file system (scripts and tests). */
export async function openNodeRepoAccess(_rootPath: string): Promise<RepoAccess> {
  throw new Error('not implemented: openNodeRepoAccess (package 1C)');
}
