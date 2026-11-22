import { describe, expect, it } from 'vitest';
import { createReplica } from '../../model';
import type { ModelPatch } from '../../model/types';
import { countLines, cutPoint, decodeContent, formatBytes } from './content';
import { isMarkdown, resolveTarget } from './files';

/** A replica holding a header + implementation pair, a lone file, and a file with no unit. */
function replica() {
  const r = createReplica();
  const ops: ModelPatch[] = [
    { op: 'add', kind: 'unit', rows: { ids: ['src/b/list.c', 'src/main.ts'], slots: [0, 1], cols: { primaryFile: ['src/b/list.c', 'src/main.ts'], fileCount: [2, 1] } } },
    {
      op: 'add', kind: 'file',
      rows: {
        ids: ['src/a/list.h', 'src/main.ts', 'src/b/list.c', 'LICENSE'], slots: [0, 1, 2, 3],
        cols: { unit: ['src/b/list.c', 'src/main.ts', 'src/b/list.c', ''], lang: ['c', 'typescript', 'c', 'other'], loc: [12, 40, 90, 21] },
      },
    },
  ];
  expect(r.apply({ rev: 1, baseRev: 0, full: true, ops })).toBe(true);
  return r;
}

describe('resolveTarget', () => {
  it('opens a unit on its primary file, with the other file as a second tab', () => {
    const t = resolveTarget(replica(), 'u:src/b/list.c')!;
    expect(t.files.map((f) => f.path)).toEqual(['src/b/list.c', 'src/a/list.h']);
    expect(t.active).toBe(0);
    expect(t.files[0]).toMatchObject({ name: 'list.c', dir: 'src/b', lang: 'c', loc: 90 });
  });

  it('opens a file ref on that file, keeping the primary file first', () => {
    const t = resolveTarget(replica(), 'f:src/a/list.h')!;
    expect(t.files.map((f) => f.path)).toEqual(['src/b/list.c', 'src/a/list.h']);
    expect(t.active).toBe(1);
  });

  it('gives a single-file unit, and a file with no unit, one tab', () => {
    expect(resolveTarget(replica(), 'u:src/main.ts')!.files.map((f) => f.path)).toEqual(['src/main.ts']);
    expect(resolveTarget(replica(), 'f:LICENSE')!.files.map((f) => f.path)).toEqual(['LICENSE']);
  });

  it('still opens a path the model does not know, and refuses what is not a file', () => {
    const unknown = resolveTarget(replica(), 'f:docs/gone.md')!;
    expect(unknown.files).toEqual([{ path: 'docs/gone.md', name: 'gone.md', dir: 'docs', lang: 'other', loc: 0, bytes: 0 }]);
    expect(unknown.active).toBe(0);
    expect(resolveTarget(null, 'u:a.ts')!.files.map((f) => f.path)).toEqual(['a.ts']);
    expect(resolveTarget(replica(), 'd:district-1')).toBeNull();
    expect(resolveTarget(replica(), 'c:city-1')).toBeNull();
  });
});

describe('content', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it('tells binary from text by a NUL near the start', () => {
    expect(decodeContent(new Uint8Array([0x89, 0x50, 0, 0x47]), 100, 100)).toEqual({ kind: 'binary' });
    expect(decodeContent(bytes('a\nb\n'), 100, 100)).toMatchObject({ kind: 'text', text: 'a\nb\n', lines: 2, truncated: false });
  });

  it('cuts an oversized file at a line end, and never inside a character', () => {
    const d = decodeContent(bytes('one\ntwo\nthree\n'), 10, 100);
    expect(d).toMatchObject({ kind: 'text', text: 'one\ntwo\n', truncated: true, shownBytes: 8, totalBytes: 14 });
    const oneLine = bytes('ééééé'); // two bytes each, no newline
    expect(cutPoint(oneLine, 5)).toBe(4);
    expect(decodeContent(oneLine, 5, 100)).toMatchObject({ text: 'éé', truncated: true });
  });

  it('counts lines the way an editor numbers them', () => {
    expect([countLines(''), countLines('a'), countLines('a\n'), countLines('a\nb'), countLines('\n\n')]).toEqual([0, 1, 1, 2, 2]);
  });

  it('formats sizes and recognises markdown', () => {
    expect([formatBytes(1), formatBytes(812), formatBytes(2 * 1024 * 1024), formatBytes(5.3 * 1024 * 1024)]).toEqual(['1 byte', '812 bytes', '2 MB', '5.3 MB']);
    expect([isMarkdown('README.md'), isMarkdown('docs/A.MARKDOWN'), isMarkdown('md.ts')]).toEqual([true, true, false]);
  });
});
