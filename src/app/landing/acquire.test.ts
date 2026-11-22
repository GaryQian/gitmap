import { describe, expect, it } from 'vitest';
import { AcquireError, folderHasAnyOf, isSnapshotName, locatorFromFileList, samplePaths, sourceFromFileList, splitTopFolder } from './acquire';

const picked = (webkitRelativePath: string): File =>
  ({ name: webkitRelativePath.split('/').pop()!, webkitRelativePath }) as unknown as File;

describe('folder input → RepoLocator', () => {
  it('names the repo after the top folder and makes paths repo-relative', () => {
    const files = [picked('myrepo/README.md'), picked('myrepo/src/a.ts'), picked('myrepo/.git/objects/ab/cdef')];
    const locator = locatorFromFileList(files);
    expect(locator.kind).toBe('files');
    expect(locator.name).toBe('myrepo');
    expect(locator.files.map((f) => f.path)).toEqual(['README.md', 'src/a.ts', '.git/objects/ab/cdef']);
    expect(locator.files[1]!.file).toBe(files[1]);
  });

  it('normalises separators and leading slashes', () => {
    expect(splitTopFolder('top\\src\\a.ts')).toEqual({ top: 'top', path: 'src/a.ts' });
    expect(splitTopFolder('/top/a.ts')).toEqual({ top: 'top', path: 'a.ts' });
    expect(splitTopFolder('loose.txt')).toEqual({ top: '', path: 'loose.txt' });
  });

  it('refuses an empty folder, with the case that says so', () => {
    expect(() => sourceFromFileList([])).toThrow(AcquireError);
    try { sourceFromFileList([]); } catch (err) { expect((err as AcquireError).status).toBe('folder-empty'); }
  });

  it('checks that a chosen folder holds some of the files of the map', async () => {
    const locator = locatorFromFileList([picked('myrepo/README.md'), picked('myrepo/src/a.ts')]);
    expect(await folderHasAnyOf(locator, ['src/a.ts', 'src/gone.ts'])).toBe(true);
    expect(await folderHasAnyOf(locator, ['lib/x.py', 'lib/y.py'])).toBe(false);
    expect(await folderHasAnyOf(locator, [])).toBe(true); // nothing to compare with
    const many = Array.from({ length: 100 }, (_, i) => `f${i}`);
    expect(samplePaths(many, 4)).toEqual(['f0', 'f25', 'f50', 'f75']);
    expect(samplePaths(['a', 'b'], 4)).toEqual(['a', 'b']);
  });

  it('recognises saved maps by name', () => {
    expect(isSnapshotName('react.starmap.json.gz')).toBe(true);
    expect(isSnapshotName('react.json.gz')).toBe(false);
  });
});
