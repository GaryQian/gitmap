// Pack a fixture repo, .git included, into one JSON file the /dev harness can load, so the whole
// folder pipeline can run in a browser without a native folder picker.
// Usage: node scripts/run.mjs scripts/bundle-fixture.ts [name]   → out/fixtures/<name>.json
//        then open /dev.html?fixture=<name>&via=opfs|files|memory
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildFixtureRepo, projectRoot } from '../src/testing/fixture';

function walk(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith('.lock')) continue;
    const rel = base ? `${base}/${name}` : name;
    if (statSync(path.join(dir, name)).isDirectory()) out.push(...walk(path.join(dir, name), rel));
    else out.push(rel);
  }
  return out;
}

export default function main(args: string[]): void {
  const name = args[0] ?? 'three-lang';
  const dir = buildFixtureRepo(name);
  const files: Record<string, string> = {};
  for (const rel of walk(dir)) files[rel] = readFileSync(path.join(dir, rel)).toString('base64');
  const out = path.join(projectRoot(), 'out/fixtures', `${name}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ name, files }));
  console.log(`${Object.keys(files).length} files → ${out}`);
}
