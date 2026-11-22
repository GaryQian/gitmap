// The facts worth pinning (IMPLEMENTATION.md §3, "Content"): a zip entry read through the directory
// equals the original file, a folder's file reads back, and a model survives export and import.
// The package file has its own tests (package.test.ts).
import { zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createModelStore, type RepoModel } from '../model';
import { syntheticMeta, syntheticTables, tablesToOps } from '../testing/synthetic';
import {
  directorySource, exportModelFile, extractZipEntry, findZipEnd, importModelFile, modelFileName, parseZipDirectory,
  ZIP_END_MAX, ZipError,
} from './index';

const enc = new TextEncoder();

function syntheticModel(files: number): RepoModel {
  const tables = syntheticTables({ files, seed: 5 });
  const store = createModelStore();
  store.propose([{ op: 'meta', value: syntheticMeta('export-test', tables) }, ...tablesToOps(tables)]);
  return store.toModel();
}

/** Text that deflates well. */
const body = (name: string, lines: number): Uint8Array =>
  enc.encode(Array.from({ length: lines }, (_, i) => `export const ${name}${i} = ${i}; // ${name}\n`).join(''));

const FILES: Record<string, Uint8Array> = {
  'src/app/main.ts': body('main', 400),
  'src/lib/útil.ts': body('util', 900),
  'docs/notes.md': enc.encode('# Notes\n\nShort, stored without compression.\n'),
  'empty.txt': new Uint8Array(0),
  'LICENSE': enc.encode('MIT License\n\nCopyright (c) someone\n'),
};

function buildZip(files: Record<string, Uint8Array> = FILES): Uint8Array {
  const input: Zippable = {};
  for (const [path, bytes] of Object.entries(files)) input[path] = [bytes, { level: path.endsWith('.md') ? 0 : 6 }];
  return zipSync(input);
}

describe('zip reader', () => {
  it('finds each entry through the directory and extracts it equal to the original file', async () => {
    const zip = buildZip();
    const end = findZipEnd(zip.subarray(Math.max(0, zip.length - ZIP_END_MAX)));
    const entries = parseZipDirectory(zip.subarray(end.cdOffset, end.cdOffset + end.cdSize), end);
    expect(entries.map((e) => e.path).sort()).toEqual(Object.keys(FILES).sort()); // a non-ASCII name among them
    expect(entries.find((e) => e.path === 'docs/notes.md')!.method).toBe(0); // stored
    expect(entries.find((e) => e.path === 'src/app/main.ts')!.method).toBe(8); // deflated
    for (const entry of entries) {
      // the span an entry is read from is exactly [offset, end): what a range request or a blob slice hands over
      expect(await extractZipEntry(zip.subarray(entry.offset, entry.end), entry)).toEqual(FILES[entry.path]);
    }
    // a flipped byte in an entry's data is caught by its CRC
    const main = entries.find((e) => e.path === 'src/app/main.ts')!;
    const damaged = zip.slice(main.offset, main.end);
    damaged[damaged.length - 5] ^= 0xff;
    await expect(extractZipEntry(damaged, main)).rejects.toBeInstanceOf(ZipError);
    expect(() => findZipEnd(new TextEncoder().encode('not a zip archive at all, just some text'))).toThrow(ZipError);
  });
});

describe('directorySource', () => {
  it('reads working-tree files from a dropped file list and is null for other locators', async () => {
    const file = new File([FILES['src/app/main.ts'] as Uint8Array<ArrayBuffer>], 'main.ts');
    const source = directorySource({ kind: 'files', name: 'repo', files: [{ path: 'src/app/main.ts', file }] });
    expect(await source!.read('u:src/app/main.ts')).toEqual(FILES['src/app/main.ts']);
    await expect(source!.read('f:gone.ts')).rejects.toThrow(/Could not read "gone.ts"/);
    expect(directorySource({ kind: 'node', rootPath: '/tmp/x' })).toBeNull();
    expect(directorySource({ kind: 'memory', name: 'm', files: {} })).toBeNull();
  });
});

describe('model file', () => {
  it('round-trips a model through export and import', async () => {
    const model = syntheticModel(60);
    const file = await exportModelFile(model);
    expect(modelFileName(model)).toBe(`${model.meta.name}.starmap.json.gz`);
    const back = await importModelFile(file);
    expect(back.meta.source).toBe('import');
    expect(back.tables).toEqual(model.tables);
    await expect(importModelFile(new Blob(['not a map']))).rejects.toThrow(/Not a starmap file/);
  });
});
