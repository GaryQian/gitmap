import { parseRef, type NodeRef } from '../model/types';

/**
 * The repo-relative path a content read is for: a file ('f:path'), or a unit ('u:path'), whose id is
 * its primary file's path. Throws for a district or city, which have no file.
 */
export function pathOfRef(ref: NodeRef): string {
  const { kind, id } = parseRef(ref);
  if (kind !== 'file' && kind !== 'unit') throw new Error(`Only a file can be opened, not a ${kind} (${ref}).`);
  return id;
}
