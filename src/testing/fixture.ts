// Node-only: builds tiny fixture repos with a real .git and scripted commits, for tests that must
// agree with git itself. A fixture lives in fixtures/<name>/ as
//   repo/           the final working-tree contents
//   commits.json    { "commits": [{ author, email, date, message, files: string[] | "all", merge? }], "packAfter"?: n }
//   stages/<n>/…    optional older contents of a file as committed by commit n (0-based)
// The built repo is written to .fixtures/<name>/ (gitignored) and reused until its inputs change.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface FixtureCommit {
  author: string;
  email: string;
  /** ISO date, used for both author and committer so `git log` is reproducible. */
  date: string;
  message: string;
  /** Paths (relative to repo/) staged by this commit, or "all" for everything not yet committed. */
  files: string[] | 'all';
  /** Paths removed by this commit. */
  remove?: string[];
}
export interface FixtureScript {
  commits: FixtureCommit[];
  /** Run `git gc` after this many commits, so earlier objects are packed and later ones stay loose. */
  packAfter?: number;
}

/** Repository root (the folder that holds package.json). */
export function projectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'fixtures'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('project root not found from ' + process.cwd());
}

function walk(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const rel = base ? `${base}/${name}` : name;
    if (statSync(path.join(dir, name)).isDirectory()) out.push(...walk(path.join(dir, name), rel));
    else out.push(rel);
  }
  return out;
}

export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', '-c', 'core.fsmonitor=false', ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env }, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'],
  }).toString('utf8');
}

/**
 * Build (or reuse) the fixture repo `name` and return its absolute path.
 * `variant` builds a separate copy, so a test that edits the working tree does not disturb others.
 */
export function buildFixtureRepo(name: string, variant = ''): string {
  const root = projectRoot();
  const src = path.join(root, 'fixtures', name);
  const script: FixtureScript = JSON.parse(readFileSync(path.join(src, 'commits.json'), 'utf8'));
  const out = path.join(root, '.fixtures', variant ? `${name}--${variant}` : name);
  const stamp = JSON.stringify([script, walk(src).map((f) => [f, statSync(path.join(src, f)).mtimeMs, statSync(path.join(src, f)).size])]);
  const stampFile = path.join(out, '.git', 'gitmap-fixture-stamp');
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) return out;

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  git(out, ['init', '-q', '-b', 'main']);
  git(out, ['config', 'user.name', 'Fixture']);
  git(out, ['config', 'user.email', 'fixture@example.com']);
  const repoDir = path.join(src, 'repo');
  const all = walk(repoDir);
  const committed = new Set<string>();
  script.commits.forEach((c, i) => {
    const files = c.files === 'all' ? all.filter((f) => !committed.has(f)) : c.files;
    for (const f of files) {
      const staged = path.join(src, 'stages', String(i), f);
      const from = existsSync(staged) ? staged : path.join(repoDir, f);
      mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
      cpSync(from, path.join(out, f));
      committed.add(f);
    }
    if (files.length) git(out, ['add', '-f', '--', ...files]);
    for (const f of c.remove ?? []) { git(out, ['rm', '-q', '--', f]); committed.delete(f); }
    const env = { GIT_AUTHOR_NAME: c.author, GIT_AUTHOR_EMAIL: c.email, GIT_AUTHOR_DATE: c.date, GIT_COMMITTER_NAME: c.author, GIT_COMMITTER_EMAIL: c.email, GIT_COMMITTER_DATE: c.date };
    git(out, ['commit', '-q', '--allow-empty', '-m', c.message], env);
    if (script.packAfter === i + 1) git(out, ['gc', '-q', '--prune=now']);
  });
  // make the working tree match repo/ exactly (stages may have left older contents)
  for (const f of committed) cpSync(path.join(repoDir, f), path.join(out, f));
  git(out, ['update-index', '--refresh', '-q']);
  writeFileSync(stampFile, stamp);
  return out;
}

/** Read the expected-results file of a fixture (fixtures/<name>/expected.json). */
export function fixtureExpected<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(path.join(projectRoot(), 'fixtures', name, 'expected.json'), 'utf8')) as T;
}

/** All files of fixtures/<name>/repo as path → text, for tests that need no git. */
export function fixtureFiles(name: string): Record<string, string> {
  const repoDir = path.join(projectRoot(), 'fixtures', name, 'repo');
  const out: Record<string, string> = {};
  for (const f of walk(repoDir)) out[f] = readFileSync(path.join(repoDir, f), 'utf8');
  return out;
}
