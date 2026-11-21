// Usage: npx tsx git/bench.ts <repo> [--max-commits N] [--time-limit-s S] [--cache-mb M]
//        [--page-kb K] [--max-pages P] [--no-profile] [--no-cochange] [--dump file.json] [--label L]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { History } from './core/history.ts';
import { NodeGitFs } from './node-fs.ts';

const args = process.argv.slice(2);
const repo = args[0];
const opt = (name: string) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes('--' + name);

const label = opt('label') ?? path.basename(repo);
const t0 = performance.now();
const h = new History(new NodeGitFs(path.join(repo, '.git')), {
  maxCommits: opt('max-commits') ? Number(opt('max-commits')) : undefined,
  timeLimitMs: opt('time-limit-s') ? Number(opt('time-limit-s')) * 1000 : undefined,
  cacheBytes: (opt('cache-mb') ? Number(opt('cache-mb')) : 64) * 1048576,
  pageSize: (opt('page-kb') !== undefined ? Number(opt('page-kb')) : 64) * 1024,
  maxPages: opt('max-pages') ? Number(opt('max-pages')) : 512,
  profile: !flag('no-profile'),
  coChangeMaxFiles: flag('no-cochange') ? 0 : 50,
  onProgress: (n, ms) => {
    const m = process.memoryUsage();
    process.stderr.write(`[${label}] ${n} commits ${(ms / 1000).toFixed(1)}s ${(n / (ms / 1000)).toFixed(0)}/s rss=${(m.rss / 1048576).toFixed(0)}MB\n`);
  },
});
const tOpen = performance.now() - t0;
const tRun0 = performance.now();
h.run();
const runMs = performance.now() - tRun0;
const s = h.odb.stats;
const cache = h.odb.cache;
const summary = {
  label,
  repo,
  stoppedBy: h.stoppedBy,
  objects: h.odb.objectCount,
  packs: h.odb.packs.length,
  openMs: +tOpen.toFixed(1),
  idxLoadMs: +h.odb.idxLoadMs.toFixed(1),
  headTreeMs: +h.headTreeMs.toFixed(1),
  runMs: +runMs.toFixed(1),
  commits: h.commitsWalked,
  commitsPerSec: +(h.commitsWalked / (runMs / 1000)).toFixed(0),
  commitReadMs: +h.commitReadMs.toFixed(1),
  diffMs: +h.diffMs.toFixed(1),
  treesRead: h.treesRead,
  treesPerCommit: +(h.treesRead / Math.max(1, h.commitsWalked)).toFixed(2),
  treeMB: +(h.treeBytes / 1048576).toFixed(1),
  filesTouched: h.filesTouched,
  paths: h.paths.length,
  headFiles: h.headFiles.size,
  headCoverage: +(h.headCovered / Math.max(1, h.headFiles.size)).toFixed(4),
  authors: h.authors.length,
  authorFileEntries: h.authorCounts.size,
  coChangePairs: h.coChange.size,
  coChangeSkippedCommits: h.coChangeSkipped,
  objectReads: s.objectReads,
  cacheHits: cache.hits,
  cacheMisses: cache.misses,
  cacheHitRate: +(cache.hits / Math.max(1, cache.hits + cache.misses)).toFixed(4),
  cacheMBAtEnd: +(cache.bytes / 1048576).toFixed(1),
  ioCalls: s.io.calls,
  ioMB: +(s.io.bytes / 1048576).toFixed(1),
  ioMs: +s.io.ms.toFixed(1),
  inflateCalls: s.inflateCalls,
  inflateMs: +s.inflateMs.toFixed(1),
  inflateMBOut: +(s.inflateBytesOut / 1048576).toFixed(1),
  deltaCalls: s.deltaCalls,
  deltaMs: +s.deltaMs.toFixed(1),
  lookupMs: +s.lookupMs.toFixed(1),
  avgChain: +(s.chainSum / Math.max(1, s.chainCount)).toFixed(2),
  maxChain: s.maxChain,
  byType: { commit: s.byType[1], tree: s.byType[2], blob: s.byType[3], tag: s.byType[4] },
  peakRssMB: +h.peakRssMB.toFixed(0),
  peakHeapMB: +h.peakHeapMB.toFixed(0),
  peakArrayBuffersMB: +h.peakArrayBuffersMB.toFixed(0),
  checkpoints: h.checkpoints.map((c) => ({ ...c, ms: +c.ms.toFixed(0), coverage: +c.coverage.toFixed(4), rssMB: +c.rssMB.toFixed(0) })),
  options: args.slice(1).join(' '),
};
console.log(JSON.stringify(summary, null, 2));
const outDir = path.join(import.meta.dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, label + '.json'), JSON.stringify(summary, null, 2));

const dump = opt('dump');
if (dump) {
  const files: Record<string, { n: number; last: number; first: number; authors: Record<string, number> }> = {};
  for (let i = 0; i < h.paths.length; i++) files[h.paths[i]] = { n: h.count[i], last: h.last[i], first: h.first[i], authors: {} };
  for (const [k, v] of h.authorCounts) {
    const pid = Math.floor(k / 1048576), aid = k % 1048576;
    const a = h.authors[aid];
    const email = a.slice(a.lastIndexOf('<') + 1, -1);
    files[h.paths[pid]].authors[email] = (files[h.paths[pid]].authors[email] ?? 0) + v;
  }
  fs.writeFileSync(dump, JSON.stringify(files));
}
