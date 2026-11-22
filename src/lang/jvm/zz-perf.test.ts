import { it, expect } from 'vitest';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fixtureFiles } from '../../testing/fixture';
import { extractJvmSymbols, scanJvm } from './index';
it('perf and robustness', () => {
  const out: string[] = [];
  const files = fixtureFiles('jvm');
  const kt = readFileSync('C:/Users/Gary/AppData/Local/Temp/claude/c7060f819453f642/3157e3e0-d84c-4ec6-9919-601d4a502596/scratchpad/Tricky.kt', 'utf8'), sc = readFileSync('C:/Users/Gary/AppData/Local/Temp/claude/c7060f819453f642/3157e3e0-d84c-4ec6-9919-601d4a502596/scratchpad/Tricky.scala', 'utf8');
  const java = Object.keys(files).filter((p) => p.endsWith('.java')).map((p) => files[p]).join('\n');
  const time = (label: string, fn: () => unknown) => { appendFileSync('C:/Users/Gary/AppData/Local/Temp/claude/c7060f819453f642/3157e3e0-d84c-4ec6-9919-601d4a502596/scratchpad/perf-live.txt', label + ' ...'); const t = performance.now(); fn(); const line = ' ' + (performance.now() - t).toFixed(0) + 'ms
'; appendFileSync('C:/Users/Gary/AppData/Local/Temp/claude/c7060f819453f642/3157e3e0-d84c-4ec6-9919-601d4a502596/scratchpad/perf-live.txt', line); out.push(label + line); };
  const big = (s: string, bytes: number) => s.repeat(Math.ceil(bytes / s.length));
  const bk = big(kt, 2e6), bs = big(sc, 2e6), bj = big(java, 2e6);
  time('scan kotlin 2MB', () => scanJvm(bk, 'kotlin'));
  time('scan scala 2MB', () => scanJvm(bs, 'scala'));
  time('scan java 2MB', () => scanJvm(bj, 'java'));
  time('symbols kotlin 2MB', () => extractJvmSymbols(bk, 'kotlin'));
  time('symbols scala 2MB', () => extractJvmSymbols(bs, 'scala'));
  const nasty = [
    'class A('.repeat(50000), 'import a.{'.repeat(50000), '"${'.repeat(100000), '/*'.repeat(100000), 'fun <'.repeat(100000),
    'x: List<'.repeat(100000), 'class A : B, '.repeat(50000), '"""', "'", '`', 'object\n'.repeat(50000), 'import a.b.{C,\n'.repeat(50000),
    'def f = { class X extends '.repeat(30000), 'a.b('.repeat(100000), '}'.repeat(100000), '{ class A '.repeat(100000) + 'def x' + ' }'.repeat(100000),
    ' '.repeat(300000) + 'class A { private fun x() {}; fun y() {} }'.repeat(20000),
  ];
  for (const [k, text] of nasty.entries()) {
    for (const lang of ['java', 'kotlin', 'scala'] as const) {
      time('nasty ' + k + ' scan ' + lang, () => expect(() => scanJvm(text, lang)).not.toThrow());
      if (lang !== 'java') time('nasty ' + k + ' symbols ' + lang, () => expect(() => extractJvmSymbols(text, lang)).not.toThrow());
    }
  }
  writeFileSync('C:/Users/Gary/AppData/Local/Temp/claude/c7060f819453f642/3157e3e0-d84c-4ec6-9919-601d4a502596/scratchpad/perf.txt', out.join('\n'));
}, 120000);
