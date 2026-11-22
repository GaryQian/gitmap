import { describe, expect, it } from 'vitest';
import { config, withConfig } from '../config';
import type { RepoAccess } from '../contracts/git';
import { MemoryWorkingTree, memoryRepo } from '../testing/memory';
import { fakeGit } from './fakeGit';
import { buildManifest } from './index';

describe('buildManifest', () => {
  it('walks a plain folder, skipping .git, node_modules, dot-directories and excluded paths', async () => {
    const repo = memoryRepo('plain', {
      'src/b.ts': 'export const b = 1;\n',
      'src/a.py': 'import os\n',
      'README.md': '# hi\n',
      '.editorconfig': 'root = true\n',
      'logo.png': 'not really a png',
      'notes.txt': 'plain text',
      '.git/config': '[core]',
      '.cache/x.ts': 'ignored',
      'node_modules/dep/index.js': 'ignored',
      'web/dist/bundle.js': 'excluded by config.parser.exclude',
      'yarn.lock': 'excluded by config.parser.exclude',
    });
    const m = await buildManifest(repo, config);
    expect(m.source).toBe('folder');
    expect(m.repoName).toBe('plain');
    expect(m.historyUnavailable).toBeTruthy();
    expect(m.headOid).toBeNull();
    expect(m.entries.map((e) => e.path)).toEqual(['.editorconfig', 'README.md', 'logo.png', 'notes.txt', 'src/a.py', 'src/b.ts']);
    expect(m.excluded).toBe(2);
    const by = Object.fromEntries(m.entries.map((e) => [e.path, e]));
    expect(by['src/b.ts']).toMatchObject({ oid: '', lang: 'ts', read: 'tree', packOffset: -1, bytes: 20 });
    expect(by['src/a.py'].lang).toBe('python');
    expect(by['notes.txt'].lang).toBeNull();
    expect(by['logo.png'].read).toBe('none');
    expect(m.totalBytes).toBe(m.entries.reduce((s, e) => s + e.bytes, 0));
  });

  it('reads the git index: drops submodules, symlinks and excluded paths, and classifies each read', async () => {
    const small = withConfig({ parser: { maxFileBytes: 100 } });
    const git = fakeGit([
      { path: 'src/z.c', text: 'int z;\n' },
      { path: 'src/a.h', text: 'int a;\n', packed: false },
      { path: 'vendor/lib/x.c', text: 'excluded' },
      { path: 'deps/sub', text: '', mode: 0o160000 },
      { path: 'link', text: 'src/z.c', mode: 0o120000 },
      { path: 'assets/icon.png', text: 'png' },
      { path: 'data/huge.json', text: '{}', size: 101 },
      { path: 'bin/run.js', text: 'run()', mode: 0o100755 },
    ]);
    const repo: RepoAccess = { name: 'tracked', tree: new MemoryWorkingTree({}), git: git.fs };
    const m = await buildManifest(repo, small, () => git.repo);
    expect(m.source).toBe('git');
    expect(m.historyUnavailable).toBeUndefined();
    expect(m.headOid).toBe('f'.repeat(40));
    expect(m.indexChecksum).toBe('c'.repeat(40));
    expect(m.remoteUrl).toBe('https://example.com/acme/repo.git');
    expect(m.excluded).toBe(3);
    expect(m.entries.map((e) => [e.path, e.read])).toEqual([
      ['assets/icon.png', 'none'],
      ['bin/run.js', 'pack'],
      ['data/huge.json', 'none'],
      ['src/a.h', 'tree'],
      ['src/z.c', 'pack'],
    ]);
    expect(m.entries.filter((e) => e.lang).map((e) => e.lang)).toEqual(['image', 'js', 'cpp', 'c']);
    const z = m.entries.find((e) => e.path === 'src/z.c')!;
    expect(z.oid).toBe(git.oidOf('src/z.c'));
    expect(z.packOffset).toBeGreaterThanOrEqual(0);
    expect(m.entries.find((e) => e.path === 'src/a.h')!.packOffset).toBe(-1);
  });

  it('falls back to the folder walk when the index cannot be read', async () => {
    const git = fakeGit([], { indexThrows: 'unsupported index version 9' });
    const repo: RepoAccess = { name: 'odd', tree: new MemoryWorkingTree({ 'a.ts': 'export {};\n' }), git: git.fs };
    const m = await buildManifest(repo, config, () => git.repo);
    expect(m.source).toBe('folder');
    expect(m.historyUnavailable).toContain('unsupported index version 9');
    expect(m.entries.map((e) => e.path)).toEqual(['a.ts']);
  });
});
