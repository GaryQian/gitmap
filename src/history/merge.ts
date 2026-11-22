// Merging chunk totals into per-file facts. Every rule is commutative and associative (counts add,
// last-modified takes the maximum, first-seen the minimum, ties are broken by values that belong to
// the commits themselves), so chunks can land in any order and an incremental walk merged into a
// saved result equals a full walk.
import { splitIdent } from './commit';
import type { Mailmap } from './mailmap';
import type { ChunkOutput, Contributor, FileHistory, HistoryJson, HistoryResult } from './types';

interface FileAcc {
  commits: number;
  last: number;
  first: number;
  /** Contributor index (internal numbering). */
  lastAuthor: number;
  lastPrefix: number;
  /** Flat pairs [contributor, commits, …]: compact, and most files have a handful of authors. */
  authors: number[];
}

interface ContributorAcc {
  /** Canonical email, lower-cased; 'name:<name>' for an author without an address. */
  key: string;
  name: string;
  /** Author time of the commit `name` was taken from. */
  nameTime: number;
  email: string;
  emails: Set<string>;
  commits: number;
  lastActive: number;
}

/** An author as written on commits: the name it has after .mailmap, and who it counts as. */
interface RawAuthor { name: string; contributor: number }

function addPair(pairs: number[], contributor: number, n: number): void {
  for (let i = 0; i < pairs.length; i += 2) {
    if (pairs[i] === contributor) { pairs[i + 1] += n; return; }
  }
  pairs.push(contributor, n);
}

export type ResultMeta = Omit<HistoryResult, 'files' | 'contributors'>;

export class HistoryAccumulator {
  private files = new Map<string, FileAcc>();
  /** The current files, when the walk was given them: facts are kept for these only. */
  private filter: Set<string> | null;
  private contributors: ContributorAcc[] = [];
  private byKey = new Map<string, number>();
  private raw: RawAuthor[] = [];
  private rawByIdent = new Map<string, number>();
  private mailmap: Mailmap | null = null;

  constructor(paths?: Iterable<string> | null) {
    this.filter = paths ? new Set(paths) : null;
  }

  /** Set before the first author is seen. */
  setMailmap(mailmap: Mailmap | null): void {
    this.mailmap = mailmap;
  }

  /** The contributor with this canonical identity: keyed by email, or by name when there is no address. */
  private contributorFor(name: string, email: string): number {
    const canonical = email.toLowerCase();
    const key = canonical || 'name:' + name.toLowerCase();
    let i = this.byKey.get(key);
    if (i === undefined) {
      i = this.contributors.length;
      this.contributors.push({ key, name: '', nameTime: -Infinity, email: canonical, emails: new Set(), commits: 0, lastActive: -Infinity });
      this.byKey.set(key, i);
    }
    return i;
  }

  /** The id of an author as written on a commit ("Name <email>"). Chunks are given these ids. */
  rawAuthor(ident: string): number {
    let id = this.rawByIdent.get(ident);
    if (id === undefined) {
      const written = splitIdent(ident);
      const who = this.mailmap ? this.mailmap.resolve(written.name, written.email) : written;
      const contributor = this.contributorFor(who.name, who.email);
      const c = this.contributors[contributor];
      const address = written.email.toLowerCase();
      if (address && address !== c.email) c.emails.add(address);
      id = this.raw.length;
      this.raw.push({ name: who.name, contributor });
      this.rawByIdent.set(ident, id);
    }
    return id;
  }

  /** The name shown is the one (after .mailmap) on the contributor's newest commit. Ties: the smaller name. */
  private sawCommit(c: ContributorAcc, name: string, time: number): void {
    if (name && (time > c.nameTime || (time === c.nameTime && name < c.name))) {
      c.name = name;
      c.nameTime = time;
    }
    if (time > c.lastActive) c.lastActive = time;
  }

  private file(path: string): FileAcc | null {
    let f = this.files.get(path);
    if (!f) {
      if (this.filter && !this.filter.has(path)) return null;
      f = { commits: 0, last: -Infinity, first: Infinity, lastAuthor: -1, lastPrefix: 0, authors: [] };
      this.files.set(path, f);
    }
    return f;
  }

  mergeChunk(out: ChunkOutput): void {
    const local = out.localAuthors.map((ident) => this.rawAuthor(ident));
    const contributorOf = (id: number): number => this.raw[id >= 0 ? id : local[-id - 1]].contributor;
    const accs = new Array<FileAcc | null>(out.paths.length);
    for (let i = 0; i < out.paths.length; i++) {
      const f = (accs[i] = this.file(out.paths[i]));
      if (!f) continue;
      f.commits += out.commits[i];
      if (out.first[i] < f.first) f.first = out.first[i];
      if (out.last[i] > f.last || (out.last[i] === f.last && out.lastOidPrefix[i] > f.lastPrefix)) {
        f.last = out.last[i];
        f.lastPrefix = out.lastOidPrefix[i];
        f.lastAuthor = contributorOf(out.lastAuthor[i]);
      }
    }
    const pairs = out.authorPairs;
    for (let k = 0; k < pairs.length; k += 3) {
      const f = accs[pairs[k]];
      if (f) addPair(f.authors, contributorOf(pairs[k + 1]), pairs[k + 2]);
    }
    for (let k = 0; k < out.authorIds.length; k++) {
      const id = out.authorIds[k];
      const raw = this.raw[id >= 0 ? id : local[-id - 1]];
      const c = this.contributors[raw.contributor];
      c.commits += out.authorCommits[k];
      this.sawCommit(c, raw.name, out.authorLast[k]);
    }
  }

  /** Add a finished result (the saved one, on an incremental walk). Paths outside the filter are dropped. */
  absorb(result: HistoryResult): void {
    const map = result.contributors.map((sc) => {
      const i = this.contributorFor(sc.name, sc.emails[0] ?? '');
      const c = this.contributors[i];
      for (const e of sc.emails) if (e && e !== c.email) c.emails.add(e);
      c.commits += sc.commits;
      this.sawCommit(c, sc.name, sc.lastActive);
      return i;
    });
    for (const [path, h] of result.files) {
      const f = this.file(path);
      if (!f) continue;
      f.commits += h.commits;
      if (h.firstSeen < f.first) f.first = h.firstSeen;
      if (h.lastModified > f.last || (h.lastModified === f.last && h.lastOidPrefix > f.lastPrefix)) {
        f.last = h.lastModified;
        f.lastPrefix = h.lastOidPrefix;
        f.lastAuthor = map[h.lastAuthor] ?? -1;
      }
      for (const [contributor, n] of h.authors) addPair(f.authors, map[contributor], n);
    }
  }

  /** Share of the current files seen at least once. 0 when the walk was not given the current files. */
  coverage(): number {
    return this.filter && this.filter.size > 0 ? this.files.size / this.filter.size : 0;
  }

  /** True when every current file has been seen. */
  allSeen(): boolean {
    return this.filter !== null && this.files.size === this.filter.size;
  }

  /** An independent copy of the facts so far, with contributors ordered by commits. */
  snapshot(meta: ResultMeta): HistoryResult {
    const order = this.contributors.map((_, i) => i).filter((i) => this.contributors[i].commits > 0);
    order.sort((a, b) => {
      const x = this.contributors[a], y = this.contributors[b];
      return y.commits - x.commits || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
    });
    const remap = new Int32Array(this.contributors.length).fill(-1);
    order.forEach((from, to) => { remap[from] = to; });
    const contributors: Contributor[] = order.map((i, id) => {
      const c = this.contributors[i];
      return { id, name: c.name, emails: [c.email, ...[...c.emails].sort()], commits: c.commits, lastActive: c.lastActive };
    });
    const files = new Map<string, FileHistory>();
    for (const [path, f] of this.files) {
      const authors: [number, number][] = [];
      for (let i = 0; i < f.authors.length; i += 2) authors.push([remap[f.authors[i]], f.authors[i + 1]]);
      authors.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      files.set(path, {
        commits: f.commits, lastModified: f.last, firstSeen: f.first, authors,
        lastAuthor: f.lastAuthor < 0 ? -1 : remap[f.lastAuthor], lastOidPrefix: f.lastPrefix,
      });
    }
    return { ...meta, files, contributors };
  }
}

/** A result as plain JSON for a snapshot. Paths are sorted, so equal results serialise identically. */
export function historyToJson(r: HistoryResult): HistoryJson {
  const paths = [...r.files.keys()].sort();
  const json: HistoryJson = {
    version: 1, merges: r.merges, mailmapHash: r.mailmapHash, headOid: r.headOid, reachedOid: r.reachedOid, reachedTime: r.reachedTime,
    commitsWalked: r.commitsWalked, complete: r.complete, recencyComplete: r.recencyComplete,
    contributors: r.contributors.map((c, id) => ({ id, name: c.name, emails: [...c.emails], commits: c.commits, lastActive: c.lastActive })),
    paths, commits: [], lastModified: [], firstSeen: [], lastAuthor: [], lastOidPrefix: [], authors: [],
  };
  if (r.stoppedBy) json.stoppedBy = r.stoppedBy;
  if (r.error) json.error = r.error;
  for (const p of paths) {
    const f = r.files.get(p)!;
    json.commits.push(f.commits);
    json.lastModified.push(f.lastModified);
    json.firstSeen.push(f.firstSeen);
    json.lastAuthor.push(f.lastAuthor);
    json.lastOidPrefix.push(f.lastOidPrefix);
    json.authors.push(f.authors.flat());
  }
  return json;
}

/** The inverse of historyToJson. Null when the data is not a version this code reads. */
export function historyFromJson(json: HistoryJson | null | undefined): HistoryResult | null {
  if (!json || json.version !== 1 || !Array.isArray(json.paths)) return null;
  const files = new Map<string, FileHistory>();
  json.paths.forEach((p, i) => {
    const flat = json.authors[i] ?? [];
    const authors: [number, number][] = [];
    for (let k = 0; k + 1 < flat.length; k += 2) authors.push([flat[k], flat[k + 1]]);
    files.set(p, {
      commits: json.commits[i], lastModified: json.lastModified[i], firstSeen: json.firstSeen[i], authors,
      lastAuthor: json.lastAuthor[i], lastOidPrefix: json.lastOidPrefix[i],
    });
  });
  const r: HistoryResult = {
    files,
    contributors: json.contributors.map((c, id) => ({ id, name: c.name, emails: [...c.emails], commits: c.commits, lastActive: c.lastActive })),
    headOid: json.headOid, reachedOid: json.reachedOid, reachedTime: json.reachedTime ?? null, commitsWalked: json.commitsWalked,
    complete: json.complete, recencyComplete: json.recencyComplete, merges: json.merges, mailmapHash: json.mailmapHash ?? '',
  };
  if (json.stoppedBy) r.stoppedBy = json.stoppedBy;
  if (json.error) r.error = json.error;
  return r;
}
