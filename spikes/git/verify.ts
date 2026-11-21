// Verify walker output against the git binary.
// Usage: npx tsx git/verify.ts <repo> <dump.json> [--samples 20]
//
// Reference semantics (identical to the walker): every commit reachable from HEAD, each
// once, diffed against its FIRST parent (root commits against the empty tree), with no
// rename detection and no path-limited history simplification:
//   git log --no-renames --diff-merges=first-parent --name-only --format=... HEAD
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

const [repo, dumpPath] = process.argv.slice(2);
const nSamples = Number(process.argv[process.argv.indexOf('--samples') + 1]) || 20;

function git(args: string[]): string {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotepath=off', '-c', 'log.showSignature=false', ...args], {
    maxBuffer: 4 * 1024 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

const t0 = performance.now();
const out = git(['log', '--no-renames', '--diff-merges=first-parent', '--name-only', '--format=%x01%H%x09%at%x09%ae', 'HEAD']);
const gitMs = performance.now() - t0;
type F = { n: number; last: number; first: number; authors: Record<string, number> };
const ref: Record<string, F> = {};
let at = 0, ae = '', commits = 0, quoted = 0;
for (const line of out.split('\n')) {
  if (!line) continue;
  if (line.charCodeAt(0) === 1) {
    const [, t, e] = line.slice(1).split('\t');
    at = Number(t);
    ae = e;
    commits++;
    continue;
  }
  let p = line;
  if (p.startsWith('"')) { quoted++; p = JSON.parse(p); }
  const f = (ref[p] ??= { n: 0, last: -Infinity, first: Infinity, authors: {} });
  f.n++;
  if (at > f.last) f.last = at;
  if (at < f.first) f.first = at;
  f.authors[ae] = (f.authors[ae] ?? 0) + 1;
}

const mine: Record<string, F> = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const refPaths = Object.keys(ref), minePaths = Object.keys(mine);
const onlyRef = refPaths.filter((p) => !(p in mine));
const onlyMine = minePaths.filter((p) => !(p in ref));
let badCount = 0, badLast = 0, badFirst = 0, badAuthors = 0;
const examples: string[] = [];
for (const p of refPaths) {
  const a = ref[p], b = mine[p];
  if (!b) continue;
  let bad = false;
  if (a.n !== b.n) { badCount++; bad = true; }
  if (a.last !== b.last) { badLast++; bad = true; }
  if (a.first !== b.first) { badFirst++; bad = true; }
  const ka = Object.keys(a.authors).sort(), kb = Object.keys(b.authors).sort();
  if (ka.join() !== kb.join() || ka.some((k) => a.authors[k] !== b.authors[k])) { badAuthors++; bad = true; }
  if (bad && examples.length < 10) examples.push(`${p}: git n=${a.n} last=${a.last} first=${a.first} | mine n=${b.n} last=${b.last} first=${b.first}`);
}

// 20 sampled HEAD files: also show what plain path-limited `git log -- path` reports,
// to document why it is NOT a comparable command (history simplification + default merge handling).
const head = git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean).sort();
const step = Math.max(1, Math.floor(head.length / nSamples));
const samples: string[] = [];
for (let i = Math.floor(step / 2); i < head.length && samples.length < nSamples; i += step) samples.push(head[i]);
const rows: string[] = [];
for (const p of samples) {
  const plain = git(['log', '--format=%at', 'HEAD', '--', p]).split('\n').filter(Boolean).map(Number);
  const fp = git(['log', '--first-parent', '--format=%at', 'HEAD', '--', p]).split('\n').filter(Boolean).map(Number);
  const r = ref[p], m = mine[p];
  rows.push(
    `| \`${p}\` | ${m?.n ?? '-'} | ${r?.n ?? '-'} | ${plain.length} | ${fp.length} | ${m ? new Date(m.last * 1000).toISOString().slice(0, 10) : '-'} | ${r ? new Date(r.last * 1000).toISOString().slice(0, 10) : '-'} | ${plain.length ? new Date(Math.max(...plain) * 1000).toISOString().slice(0, 10) : '-'} | ${m && r && m.n === r.n && m.last === r.last && m.first === r.first ? 'yes' : 'NO'} |`,
  );
}

console.log(JSON.stringify({ repo, gitLogMs: +gitMs.toFixed(0), gitCommits: commits, quotedPaths: quoted, refPaths: refPaths.length, minePaths: minePaths.length, onlyRef: onlyRef.length, onlyMine: onlyMine.length, onlyRefEx: onlyRef.slice(0, 5), onlyMineEx: onlyMine.slice(0, 5), badCount, badLast, badFirst, badAuthors, examples }, null, 2));
console.log('\n| file | walker commits | git (ref cmd) commits | plain `git log -- f` | `--first-parent -- f` | walker last | ref last | plain last | walker == ref |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(r);
