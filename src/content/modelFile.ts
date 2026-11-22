// Export and import (PLAN.md §12): the same `.gitmap.json.gz` file the snapshot and the demos use.
// An exported map holds no file contents.
import { decodeModel, encodeModel, type RepoModel } from '../model';

export const MODEL_FILE_SUFFIX = '.gitmap.json.gz';

/** "<name>.gitmap.json.gz", with characters a file system would refuse replaced. */
export function modelFileName(model: Pick<RepoModel, 'meta'>): string {
  const name = model.meta.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s-]+|[.\s-]+$/g, '');
  return (name || 'map') + MODEL_FILE_SUFFIX;
}

/** The model as a downloadable file. Asynchronous because the gzip encoder is. */
export async function exportModelFile(model: RepoModel): Promise<Blob> {
  const bytes = await encodeModel(model);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/gzip' });
}

/** Save the model through the browser's download flow as "<name>.gitmap.json.gz". */
export async function downloadModel(model: RepoModel): Promise<void> {
  const url = URL.createObjectURL(await exportModelFile(model));
  const link = document.createElement('a');
  link.href = url;
  link.download = modelFileName(model);
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // the download reads the blob after the click returns
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Read an exported or dropped map. Rejects with a readable message when the file is not a gitmap
 * file or was written by a newer schema. The result is marked as an import, whatever wrote it.
 *
 * `meta.parserVersion` is left as the file has it: it says which parser produced these facts, and an
 * import cannot be parsed again to make another answer true. The snapshot store discards snapshots
 * of a different parser version, so an import is meant to stay out of it (and out of the registry):
 * it lasts for the visit, and the file is dropped again to reopen it.
 */
export async function importModelFile(file: Blob): Promise<RepoModel> {
  const model = await decodeModel(new Uint8Array(await file.arrayBuffer()));
  return { ...model, meta: { ...model.meta, source: 'import' } };
}

/** True when a dropped file's name says it is an exported map. */
export function isModelFileName(name: string): boolean {
  return name.toLowerCase().endsWith(MODEL_FILE_SUFFIX) || name.toLowerCase().endsWith('.gitmap.json');
}
