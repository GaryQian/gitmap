// Parsers for the contents of commit, tree and tag objects.
import type { GitObjectType } from '../contracts/git';
import { decodeText, toHex } from './bytes';

export const MODE_TREE = 0o040000;
export const MODE_FILE = 0o100644;
export const MODE_EXEC = 0o100755;
export const MODE_SYMLINK = 0o120000;
/** A submodule entry: its oid is a commit in another repository. */
export const MODE_GITLINK = 0o160000;

export interface GitPerson {
  name: string;
  email: string;
  /** Seconds since the Unix epoch. */
  time: number;
  /** Offset of the person's time zone from UTC, in minutes (+0130 → 90). */
  tz: number;
}

export interface ParsedCommit {
  /** Hex oid of the root tree. */
  tree: string;
  /** Hex oids of the parents: none for a root commit, two or more for a merge. */
  parents: string[];
  author: GitPerson;
  committer: GitPerson;
  message: string;
}

export interface ParsedTag {
  /** Hex oid of the tagged object. */
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: GitPerson | null;
  message: string;
}

export interface TreeEntry {
  /** File mode: MODE_TREE for a subdirectory, MODE_FILE, MODE_EXEC, MODE_SYMLINK or MODE_GITLINK. */
  mode: number;
  name: string;
  /** Hex oid of the blob, subtree or (for a gitlink) commit. */
  oid: string;
}

const NOBODY: GitPerson = { name: '', email: '', time: 0, tz: 0 };

function startsWith(b: Uint8Array, at: number, word: string): boolean {
  for (let i = 0; i < word.length; i++) if (b[at + i] !== word.charCodeAt(i)) return false;
  return true;
}

/** Parse "Name <email> 1700000000 +0100" in b[s..e). */
function parsePerson(b: Uint8Array, s: number, e: number): GitPerson {
  let gt = e - 1;
  while (gt >= s && b[gt] !== 62) gt--;
  if (gt < s) return { ...NOBODY, name: decodeText(b, s, e).trim() };
  let lt = gt - 1;
  while (lt >= s && b[lt] !== 60) lt--;
  const name = lt > s ? decodeText(b, s, lt).trim() : '';
  const email = decodeText(b, Math.max(lt + 1, s), gt);
  let p = gt + 1;
  while (p < e && b[p] === 32) p++;
  let neg = false;
  if (b[p] === 45) { neg = true; p++; }
  let time = 0;
  while (p < e && b[p] >= 48 && b[p] <= 57) time = time * 10 + (b[p++] - 48);
  if (neg) time = -time;
  while (p < e && b[p] === 32) p++;
  let tz = 0;
  if (p + 5 <= e && (b[p] === 43 || b[p] === 45)) {
    const hh = (b[p + 1] - 48) * 10 + (b[p + 2] - 48);
    const mm = (b[p + 3] - 48) * 10 + (b[p + 4] - 48);
    tz = (hh * 60 + mm) * (b[p] === 45 ? -1 : 1);
  }
  return { name, email, time, tz };
}

/** Walk "key value" header lines up to the blank line; returns where the message starts. */
function eachHeader(data: Uint8Array, line: (start: number, end: number) => void): number {
  let pos = 0;
  while (pos < data.length) {
    let e = data.indexOf(10, pos);
    if (e < 0) e = data.length;
    if (e === pos) return pos + 1;
    line(pos, e);
    pos = e + 1;
  }
  return data.length;
}

/** Parse the content of a commit object. Multi-line headers (gpgsig, mergetag) are skipped. */
export function parseCommit(data: Uint8Array): ParsedCommit {
  let tree = '';
  const parents: string[] = [];
  let author = NOBODY, committer = NOBODY;
  const body = eachHeader(data, (s, e) => {
    if (startsWith(data, s, 'tree ')) tree = decodeText(data, s + 5, e);
    else if (startsWith(data, s, 'parent ')) parents.push(decodeText(data, s + 7, e));
    else if (startsWith(data, s, 'author ')) author = parsePerson(data, s + 7, e);
    else if (startsWith(data, s, 'committer ')) committer = parsePerson(data, s + 10, e);
  });
  if (tree.length !== 40) throw new Error('git: commit without a tree');
  return { tree, parents, author, committer, message: decodeText(data, body) };
}

/** Parse the content of an annotated tag object. */
export function parseTag(data: Uint8Array): ParsedTag {
  let object = '', type = '', tag = '';
  let tagger: GitPerson | null = null;
  const body = eachHeader(data, (s, e) => {
    if (startsWith(data, s, 'object ')) object = decodeText(data, s + 7, e);
    else if (startsWith(data, s, 'type ')) type = decodeText(data, s + 5, e);
    else if (startsWith(data, s, 'tag ')) tag = decodeText(data, s + 4, e);
    else if (startsWith(data, s, 'tagger ')) tagger = parsePerson(data, s + 7, e);
  });
  if (object.length !== 40) throw new Error('git: tag without an object');
  return { object, type: type as GitObjectType, tag, tagger, message: decodeText(data, body) };
}

/**
 * Iterate the entries of a tree object, in stored order (git's order: by name bytes, with a
 * directory compared as if its name ended in '/').
 */
export function* treeEntries(data: Uint8Array): Generator<TreeEntry> {
  let p = 0;
  const n = data.length;
  while (p < n) {
    let mode = 0;
    while (p < n && data[p] !== 32) mode = mode * 8 + (data[p++] - 48);
    const nameStart = ++p;
    while (p < n && data[p] !== 0) p++;
    if (p + 21 > n) throw new Error('git: truncated tree object');
    yield { mode, name: decodeText(data, nameStart, p), oid: toHex(data, p + 1) };
    p += 21;
  }
}

/** All entries of a tree object. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  return [...treeEntries(data)];
}
