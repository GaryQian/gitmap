// openGitRepo: refs, the index, .git/config and the object database behind the GitRepo contract.
import { config } from '../config';
import type { GitFs, GitObjectType, GitRepo, IndexEntry } from '../contracts/git';
import { decodeText, hexToBytes, isOid, sha1, toHex } from './bytes';
import { parseGitIndex, UnsupportedIndexError } from './gitIndex';
import { ObjectDb, typeName } from './odb';

export interface GitRepoOptions {
  /** Page size for pack reads. Default config.history.pageBytes. */
  pageBytes?: number;
  /** Object cache budget in bytes. Default config.history.objectCacheBytes. */
  cacheBytes?: number;
  /** Budget of the pack page cache, shared by all packs of the repo. Default config.history.pageCacheBytes. */
  pageCacheBytes?: number;
}

/** What openGitRepo returns: the GitRepo contract plus the pieces the history walker builds on. */
export interface GitRepository extends GitRepo {
  /** The object database, for readers that work with 20-byte ids and type codes. */
  readonly odb: ObjectDb;
  /** Hex oid a full ref name ('refs/heads/main', 'HEAD') points at, following symbolic refs. Null when unset. */
  resolveRef(name: string): string | null;
  /** Which pack holds an object (index into odb.packs) and at what offset. Null when loose or absent. */
  locate(oid: string): { pack: number; offset: number } | null;
  /** Entries of .git/config, in file order. */
  configEntries(): GitConfigEntry[];
}

export interface GitConfigEntry {
  /** Lower-cased section name, e.g. 'remote'. */
  section: string;
  /** Subsection as written, e.g. 'origin'; null when the section has none. */
  subsection: string | null;
  /** Lower-cased key. */
  key: string;
  value: string;
}

/** Parse git's config file format: sections, quoted subsections, comments, quoting and line continuations. */
export function parseGitConfig(text: string): GitConfigEntry[] {
  const out: GitConfigEntry[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let section = '';
  let subsection: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.startsWith('[')) {
      const m = /^\[\s*([A-Za-z0-9.-]+)\s*(?:"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
      if (!m) continue;
      const dot = m[1].indexOf('.');
      if (m[2] !== undefined) {
        section = m[1].toLowerCase();
        subsection = m[2].replace(/\\(.)/g, '$1');
      } else if (dot >= 0) {
        section = m[1].slice(0, dot).toLowerCase(); // legacy [section.subsection]
        subsection = m[1].slice(dot + 1).toLowerCase();
      } else {
        section = m[1].toLowerCase();
        subsection = null;
      }
      line = line.slice(m[0].length).trim();
    }
    if (!line || line[0] === '#' || line[0] === ';' || !section) continue;
    const eq = line.indexOf('=');
    const key = (eq < 0 ? line.replace(/\s*[#;].*$/, '') : line.slice(0, eq)).trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(key)) continue;
    if (eq < 0) { out.push({ section, subsection, key, value: 'true' }); continue; }
    let raw = line.slice(eq + 1);
    let value = '';
    let keep = 0; // length of `value` that survives trimming of trailing blanks
    let quoted = false;
    for (let k = 0; k < raw.length; k++) {
      const c = raw[k];
      if (c === '\\') {
        if (k === raw.length - 1) {
          // a trailing backslash continues the value on the next line
          if (i + 1 < lines.length) { raw = lines[++i]; k = -1; }
          continue;
        }
        const n = raw[++k];
        value += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'b' ? '\b' : n;
        keep = value.length;
      } else if (c === '"') {
        quoted = !quoted;
        keep = value.length;
      } else if (!quoted && (c === '#' || c === ';')) break;
      else {
        value += c;
        if (quoted || (c !== ' ' && c !== '\t')) keep = value.length;
      }
    }
    out.push({ section, subsection, key, value: value.slice(0, keep).replace(/^[ \t]+/, '') });
  }
  return out;
}

const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443', git: '9418' };

/**
 * A remote URL without scheme, credentials or the ".git" suffix: "git@github.com:a/b.git",
 * "ssh://git@github.com/a/b" and "https://user:token@github.com/a/b.git" all become "github.com/a/b".
 * A local path is returned with '/' separators. Null for an empty URL.
 */
export function normalizeRemoteUrl(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  const tidy = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  let host: string;
  let path: string;
  const withScheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(u);
  if (withScheme) {
    const scheme = withScheme[1].toLowerCase();
    if (scheme === 'file') return tidy(withScheme[2]) || null;
    const rest = withScheme[2];
    const slash = rest.indexOf('/');
    let authority = slash < 0 ? rest : rest.slice(0, slash);
    path = slash < 0 ? '' : rest.slice(slash + 1);
    authority = authority.slice(authority.lastIndexOf('@') + 1); // drop user[:password]@
    const port = /:(\d+)$/.exec(authority);
    if (port && (scheme.includes('ssh') || DEFAULT_PORTS[scheme] === port[1])) authority = authority.slice(0, port.index);
    host = authority.toLowerCase();
  } else {
    // scp-like "[user@]host:path". A one-letter "host" is a Windows drive, and a '/' before the ':' means a path.
    const scp = /^(?:[^@/\\:]+@)?([^@/\\:]{2,}):(.*)$/.exec(u);
    if (!scp) return tidy(u) || null;
    host = scp[1].toLowerCase();
    path = scp[2];
  }
  path = tidy(path.replace(/[?#].*$/, '')).replace(/^\/+/, '');
  if (!host) return path || null;
  return path ? `${host}/${path}` : host;
}

function safeRefName(name: string): boolean {
  return name.length > 0 && name[0] !== '/' && !/[\\\0]/.test(name) && !name.split('/').includes('..');
}

/** A parsed view over a .git directory. Cheap to create: packs are opened on the first object read. */
export function openGitRepo(fs: GitFs, opts: GitRepoOptions = {}): GitRepository {
  const cacheBytes = opts.cacheBytes ?? config.history.objectCacheBytes;
  const odb = new ObjectDb(fs, {
    pageBytes: opts.pageBytes ?? config.history.pageBytes,
    cacheBytes,
    pageCacheBytes: opts.pageCacheBytes ?? config.history.pageCacheBytes,
  });

  const readFile = (path: string): Uint8Array | null => {
    const n = fs.size(path);
    return n < 0 ? null : n === 0 ? new Uint8Array(0) : fs.readAt(path, 0, n);
  };
  const readText = (path: string): string | null => {
    const b = readFile(path);
    return b ? decodeText(b) : null;
  };
  const configEntries = (): GitConfigEntry[] => parseGitConfig(readText('config') ?? '');
  const isSha256 = (): boolean =>
    configEntries().some((e) => e.section === 'extensions' && e.key === 'objectformat' && e.value.toLowerCase() === 'sha256');

  function packedRef(name: string): string | null {
    const text = readText('packed-refs');
    if (!text) return null;
    // lines are "<oid> <refname>"; '#' starts the header and '^' a peeled tag target
    for (const line of text.split('\n')) {
      if (line.length > 41 && line[40] === ' ' && line.slice(41).trimEnd() === name) {
        const oid = line.slice(0, 40);
        return isOid(oid) ? oid : null;
      }
    }
    return null;
  }

  function resolveRef(name: string, depth = 0): string | null {
    if (depth > 10 || !safeRefName(name)) return null;
    const loose = readText(name)?.trim();
    if (loose) {
      if (loose.startsWith('ref:')) return resolveRef(loose.slice(4).trim(), depth + 1);
      return isOid(loose) ? loose : null;
    }
    return packedRef(name);
  }

  return {
    fs,
    odb,
    resolveRef: (name) => resolveRef(name),
    configEntries,

    head() {
      const text = readText('HEAD')?.trim();
      if (!text) return { oid: null, ref: null };
      if (text.startsWith('ref:')) {
        const ref = text.slice(4).trim();
        return { oid: resolveRef(ref), ref };
      }
      return { oid: isOid(text) ? text : null, ref: null };
    },

    indexEntries(): IndexEntry[] {
      const buf = readFile('index');
      if (!buf) return []; // a repository with nothing staged yet has no index file
      if (isSha256()) throw new UnsupportedIndexError('sha256', 'git index: SHA-256 repositories are not supported');
      return parseGitIndex(buf);
    },

    indexChecksum(): string {
      const n = fs.size('index');
      if (n < 20) return '';
      const trailer = fs.readAt('index', n - 20, 20);
      if (trailer.some((b) => b !== 0)) return toHex(trailer);
      // index.skipHash leaves the trailer zeroed: compute what git would have written
      return toHex(sha1(fs.readAt('index', 0, n - 20)));
    },

    remoteUrl(): string | null {
      const urls = configEntries().filter((e) => e.section === 'remote' && e.key === 'url' && e.subsection !== null);
      const pick = urls.find((e) => e.subsection === 'origin') ?? urls[0];
      return pick ? normalizeRemoteUrl(pick.value) : null;
    },

    readObject(oid: string): { type: GitObjectType; data: Uint8Array } | null {
      const o = odb.readHex(oid);
      return o ? { type: typeName(o.type), data: o.data } : null;
    },

    isPacked(oid: string): boolean {
      return isOid(oid) && odb.locate(hexToBytes(oid)) !== null;
    },

    packOffset(oid: string): number {
      const loc = isOid(oid) ? odb.locate(hexToBytes(oid)) : null;
      return loc ? loc.offset : -1;
    },

    locate(oid: string) {
      return isOid(oid) ? odb.locate(hexToBytes(oid)) : null;
    },

    isShallow(): boolean {
      return fs.size('shallow') > 0;
    },
  };
}
