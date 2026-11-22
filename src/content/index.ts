// Public surface of src/content (browser-safe). Package 3N owns this folder.
// One way to read a file, whatever the source (PLAN.md §12.1), and the export / import file (§12).
//
//   directorySource(locator)        → ContentSource | null   the user's folder ('fsa', 'files')   (directory.ts)
//   demoSource(baseUrl, { oidOf })  → DemoSource             content.zip, one entry per range     (demo.ts)
//   exportModelFile / downloadModel / importModelFile        the .gitmap.json.gz file             (modelFile.ts)
//   findZipEnd / parseZipDirectory / extractZipEntry         the zip reader behind demoSource     (zip.ts)
//
// Every source's read() takes 'f:path' or 'u:path' (a unit's primary file) and rejects otherwise.
export { directorySource } from './directory';
export { demoSource, ContentMismatchError, type ContentCache, type DemoSource, type DemoSourceOptions } from './demo';
export {
  exportModelFile, downloadModel, importModelFile, modelFileName, isModelFileName, MODEL_FILE_SUFFIX,
} from './modelFile';
export { pathOfRef } from './refs';
export {
  findZipEnd, parseZipDirectory, extractZipEntry, inflateRaw, crc32, ZipError, ZIP_END_MAX,
  type ZipEnd, type ZipEntry,
} from './zip';
