// Public surface of src/content (browser-safe). Package 3N owns this folder.
// One way to read a file, whatever the source (PLAN.md §12.1), and the export / import file (§12).
//
//   directorySource(locator)        → ContentSource | null   the user's folder ('fsa', 'files')   (directory.ts)
//   writePackage(opts)              → PackageReport          a map and its files as one .starmap.zip (package.ts)
//   openPackage(url, { oidOf })     → OpenedPackage          a package by URL: the map first, then the files
//   readPackage(blob, { oidOf })    → OpenedPackage          a package in hand (a dropped file)
//   detectLicense / licenseOf                                the repo's licence, for the manifest  (license.ts)
//   exportModelFile / downloadModel / importModelFile        the .starmap.json.gz file             (modelFile.ts)
//   findZipEnd / parseZipDirectory / extractZipEntry         the zip reader behind the package     (zip.ts)
//
// Every source's read() takes 'f:path' or 'u:path' (a unit's primary file) and rejects otherwise.
export { directorySource } from './directory';
export { detectLicense, licenseOf, UNKNOWN_LICENSE } from './license';
export {
  exportModelFile, downloadModel, importModelFile, modelFileName, isModelFileName, MODEL_FILE_SUFFIX,
} from './modelFile';
export {
  writePackage, openPackage, readPackage, packOrder, packageFileName, isPackageFileName, sourceUrlOf, memorySink,
  NotInPackageError, PackageMismatchError, PackageFormatError,
  PACKAGE_SUFFIX, PACKAGE_FORMAT, MANIFEST_ENTRY, MAP_ENTRY, FILES_PREFIX, LICENSE_CANDIDATES,
  type PackageManifest, type PackageSink, type PackageReport, type WritePackageOptions,
  type PackageCache, type PackageContent, type OpenedPackage, type OpenPackageOptions, type ReadPackageOptions,
} from './package';
export { pathOfRef } from './refs';
export {
  findZipEnd, parseZipDirectory, extractZipEntry, inflateRaw, crc32, ZipError, ZIP_END_MAX,
  type ZipEnd, type ZipEntry,
} from './zip';
