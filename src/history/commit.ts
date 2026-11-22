// The few commit headers the walk needs, parsed without decoding the message.
import { decodeText } from '../git';

export interface CommitHeader {
  tree: string;
  parents: string[];
  /** "Name <email>" exactly as written. */
  ident: string;
  authorTime: number;
  commitTime: number;
}

function hexAt(b: Uint8Array, at: number): string {
  let s = '';
  for (let i = at; i < at + 40; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** The decimal number that follows the last '>' of b[s..e), or 0. */
function timeAfterIdent(b: Uint8Array, gt: number, e: number): number {
  let p = gt + 1;
  while (p < e && b[p] === 32) p++;
  let neg = false;
  if (b[p] === 45) { neg = true; p++; }
  let v = 0;
  while (p < e && b[p] >= 48 && b[p] <= 57) v = v * 10 + (b[p++] - 48);
  return neg ? -v : v;
}

/** Parse the content of a commit object up to its committer line. Null when it has no tree. */
export function parseCommitHeader(b: Uint8Array): CommitHeader | null {
  let tree = '';
  const parents: string[] = [];
  let ident = '';
  let authorTime = 0, commitTime = 0;
  let pos = 0;
  const n = b.length;
  while (pos < n) {
    let e = b.indexOf(10, pos);
    if (e < 0) e = n;
    if (e === pos) break; // blank line: the message follows
    const c0 = b[pos];
    if (c0 === 116 /* t */ && b[pos + 4] === 32 && e - pos >= 45) tree = hexAt(b, pos + 5);
    else if (c0 === 112 /* p */ && b[pos + 6] === 32 && e - pos >= 47) parents.push(hexAt(b, pos + 7));
    else if (c0 === 97 /* a */ && b[pos + 6] === 32 && b[pos + 1] === 117 /* u */) {
      let gt = e - 1;
      while (gt > pos + 6 && b[gt] !== 62) gt--;
      if (b[gt] === 62) {
        ident = decodeText(b, pos + 7, gt + 1);
        authorTime = timeAfterIdent(b, gt, e);
      } else ident = decodeText(b, pos + 7, e).trim();
    } else if (c0 === 99 /* c */ && b[pos + 9] === 32 && b[pos + 1] === 111 /* o */) {
      let gt = e - 1;
      while (gt > pos + 9 && b[gt] !== 62) gt--;
      if (b[gt] === 62) commitTime = timeAfterIdent(b, gt, e);
      break; // nothing after the committer is needed (and gpgsig spans several lines)
    }
    pos = e + 1;
  }
  return tree ? { tree, parents, ident, authorTime, commitTime } : null;
}

/** "Name <email>" → its two parts. A string without '<' is all name. */
export function splitIdent(ident: string): { name: string; email: string } {
  const lt = ident.lastIndexOf('<');
  if (lt < 0) return { name: ident.trim(), email: '' };
  const gt = ident.indexOf('>', lt);
  return { name: ident.slice(0, lt).trim(), email: ident.slice(lt + 1, gt < 0 ? ident.length : gt).trim() };
}
