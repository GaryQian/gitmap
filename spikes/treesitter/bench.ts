// Single-threaded slow-pass benchmark.
// usage: npx tsx treesitter/bench.ts --repo <path> --langs typescript,tsx,javascript [--limit N] [--no-delete] [--no-cap] [--no-query] [--tag name]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getLang, listFiles, processFile, type FileResult } from './lib.ts';

const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k: string) => argv.includes(k);
const repo = arg('--repo')!;
const langs = new Set(arg('--langs')!.split(','));
const limit = Number(arg('--limit', '0'));
const capMs = flag('--no-cap') ? 0 : Number(arg('--cap', '10000'));
const runQuery = !flag('--no-query');
const keep = flag('--no-delete') ? [] as any[] : null;
const tag = arg('--tag', path.basename(repo) + '-' + [...langs].join('+'));

let files = listFiles(repo, langs);
// deterministic shuffle so a --limit sample is spread across the tree
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = files.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [files[i], files[j]] = [files[j], files[i]]; }
if (limit > 0) files = files.slice(0, limit);

for (const l of langs) await getLang(l);
const dec = new TextDecoder('utf-8');
const results: FileResult[] = [];
let peakRss = process.memoryUsage().rss; const rss0 = peakRss;
let readMs = 0, decodeMs = 0;
const rssTrace: [number, number][] = [];
const wall0 = performance.now();
for (let i = 0; i < files.length; i++) {
  const { rel, lang } = files[i];
  const r0 = performance.now();
  const buf = readFileSync(path.join(repo, rel));
  const r1 = performance.now();
  const text = dec.decode(buf);
  const r2 = performance.now();
  readMs += r1 - r0; decodeMs += r2 - r1;
  const b = await getLang(lang);
  results.push(processFile(b, rel, lang, text, buf.length, capMs, runQuery, keep));
  if ((i & 15) === 0) { const rss = process.memoryUsage().rss; if (rss > peakRss) peakRss = rss; }
  if (i % 500 === 0) rssTrace.push([i, Math.round(process.memoryUsage().rss / 1048576)]);
}
const wallMs = performance.now() - wall0;
peakRss = Math.max(peakRss, process.memoryUsage().rss);

function summarise(rs: FileResult[]) {
  const bytes = rs.reduce((a, r) => a + r.bytes, 0);
  const parse = rs.reduce((a, r) => a + r.parseMs, 0);
  const query = rs.reduce((a, r) => a + r.queryMs, 0);
  const sorted = rs.map(r => r.parseMs + r.queryMs).sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return {
    files: rs.length, MB: +(bytes / 1048576).toFixed(2),
    parseMs: Math.round(parse), queryMs: Math.round(query),
    queryOverParsePct: +(100 * query / parse).toFixed(1),
    parseMBps: +((bytes / 1048576) / (parse / 1000)).toFixed(2),
    totalMBps: +((bytes / 1048576) / ((parse + query) / 1000)).toFixed(2),
    filesPerSec: Math.round(rs.length / ((parse + query) / 1000)),
    meanMsPerFile: +((parse + query) / rs.length).toFixed(2),
    p50Ms: +pct(0.5).toFixed(2), p95Ms: +pct(0.95).toFixed(2), p99Ms: +pct(0.99).toFixed(2), maxMs: +pct(1).toFixed(1),
    over2s: rs.filter(r => r.parseMs + r.queryMs > 2000).length,
    cancelled: rs.filter(r => r.cancelled).length,
    withSyntaxErrors: rs.filter(r => r.hasError).length,
    defs: rs.reduce((a, r) => a + r.defs, 0), refs: rs.reduce((a, r) => a + r.refs, 0),
  };
}
const byLang: Record<string, any> = {};
for (const l of langs) byLang[l] = summarise(results.filter(r => r.lang === l));
const all = summarise(results);
const worst = [...results].sort((a, b) => (b.parseMs + b.queryMs) - (a.parseMs + a.queryMs)).slice(0, 5)
  .map(r => ({ rel: r.rel, KB: Math.round(r.bytes / 1024), parseMs: Math.round(r.parseMs), queryMs: Math.round(r.queryMs), cancelled: r.cancelled }));
// warm-up effect: first 200 files vs the rest
const head = summarise(results.slice(0, 200)), tail = summarise(results.slice(200));
const out = {
  tag, repo, node: process.version, capMs, runQuery, deleteTrees: !keep,
  wallMs: Math.round(wallMs), readMs: Math.round(readMs), decodeMs: Math.round(decodeMs),
  rssStartMB: Math.round(rss0 / 1048576), peakRssMB: Math.round(peakRss / 1048576), rssTrace,
  all, byLang, warmup: { first200MBps: head.totalMBps, restMBps: tail.totalMBps }, worst,
};
console.log(JSON.stringify(out, null, 1));
writeFileSync(path.join(import.meta.dirname, `out-${tag}.json`), JSON.stringify(out, null, 1));
writeFileSync(path.join(import.meta.dirname, `out-${tag}.files.json`), JSON.stringify(results.map(r => [r.rel, r.lang, r.bytes, +r.parseMs.toFixed(3), +r.queryMs.toFixed(3)])));
