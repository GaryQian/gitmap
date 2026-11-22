// The settings card's "Export", without React (plan/DEMO-MODE.md §3). "Map and files" writes the
// package: it finishes the AI work when the viewer has agreed to AI for this repo (every detail card
// of every point of interest), exports the model, and packs the files the map was built from into
// one `<name>.starmap.zip`. "Map only" is the `.starmap.json.gz` the app has always exported, and
// needs nothing from here. ExportRow.tsx holds the state and the buttons.
import { toAiErrorInfo } from '../../ai';
import {
  licenseOf, memorySink, sourceUrlOf, writePackage, type PackageManifest, type PackageReport, type PackageSink,
} from '../../content';
import { DETAIL_QUESTIONS, type DetailQuestion } from '../../contracts/ai';
import type { Session } from '../../contracts/pipeline';
import type { Annotation, RepoMeta, RepoModel } from '../../model/types';
import type { AiController, AiRunOutcome } from '../ai';
import { countLabel, formatBytes } from '../units';

/** Every question a point of interest can be asked: one detail card each. */
export const DETAIL_KEYS = Object.keys(DETAIL_QUESTIONS) as DetailQuestion[];

/** Detail cards asked for at the same time. */
const DETAILS_IN_FLIGHT = 3;
/** Failures in a row after which no more detail cards are asked for: the rest would fail the same way. */
const GIVE_UP_AFTER = 3;
/** Failures no further request can get past. */
const HOPELESS = new Set(['disabled', 'no_key', 'unavailable']);

// ---- pure rules ----

export interface DetailCard { poiId: string; question: DetailQuestion }

/** The detail cards that have no stored answer yet, point by point, in question order. */
export function missingDetails(annotations: readonly Annotation[], questions: readonly DetailQuestion[] = DETAIL_KEYS): DetailCard[] {
  const out: DetailCard[] = [];
  for (const a of annotations) {
    if (a.type !== 'poi') continue;
    for (const question of questions) {
      if (a.details?.[question]?.status !== 'ready') out.push({ poiId: a.id, question });
    }
  }
  return out;
}

/**
 * What the manifest says about the AI work a map carries: 'complete' when it has summaries, points
 * of interest and a tour, and every point has every detail card; 'none' when it has no AI
 * annotations at all; 'partial' for anything between.
 */
export function aiCompleteness(annotations: readonly Annotation[], questions: readonly DetailQuestion[] = DETAIL_KEYS): PackageManifest['ai'] {
  if (annotations.length === 0) return 'none';
  const complete = annotations.some((a) => a.type === 'summary')
    && annotations.some((a) => a.type === 'poi')
    && annotations.some((a) => a.type === 'tour' && a.steps.length > 0)
    && missingDetails(annotations, questions).length === 0;
  return complete ? 'complete' : 'partial';
}

/** A model's annotations as one list, the way a replica holds them. */
export function annotationsOf(model: Pick<RepoModel, 'annotations'>): Annotation[] {
  const { summaries, pois, tours } = model.annotations;
  return [...(summaries ?? []), ...(pois ?? []), ...(tours ?? [])];
}

/**
 * The entry to add to `demo.repos` in config.json for an exported package, as one line. `location`
 * is the source without its scheme ("github.com/facebook/react"); it is left out when there is none.
 */
export function configLine(name: string, fileName: string, sourceUrl: string): string {
  const fields = [`"name": ${JSON.stringify(name)}`, `"file": ${JSON.stringify(`/demo/${fileName}`)}`];
  const location = sourceUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  if (location) fields.push(`"location": ${JSON.stringify(location)}`);
  return `{ ${fields.join(', ')} }`;
}

/** What the confirmation says about a map that is not finished. Exporting it is still allowed. */
export function incompleteNotes(meta: Pick<RepoMeta, 'structure' | 'history'> | null): string[] {
  const notes: string[] = [];
  if (meta?.structure === 'imports-only') notes.push('The refined structure has not been applied.');
  if (meta?.history && !meta.history.complete) notes.push('History was loaded only up to its cap.');
  return notes;
}

const count = (n: number): string => n.toLocaleString('en-US');

/** "Writing detail cards 12 / 60" */
export function detailLine(done: number, total: number): string {
  return `Writing detail cards ${count(done)} / ${count(total)}`;
}

/** "Packing files 6,214 / 21,300 · 48 MB" */
export function packingLine(done: number, total: number, bytes: number): string {
  return `Packing files ${count(done)} / ${count(total)} · ${formatBytes(bytes)}`;
}

export interface ExportResult {
  /** The name the package was saved under. */
  fileName: string;
  report: PackageReport;
  /** Why the AI step did not finish, as one sentence; null when it did, or was not asked for. */
  aiFailure: string | null;
  /** The entry for `demo.repos` in config.json. */
  configLine: string;
}

/** The result, line by line: the file, then what was left out, then what the AI step could not do. */
export function resultLines(result: ExportResult): string[] {
  const { report } = result;
  const lines = [`${result.fileName} · ${formatBytes(report.bytes)} · ${countLabel(report.packedFiles, 'file', 'files')}`];
  if (report.trimmedFiles > 0) lines.push(`${countLabel(report.trimmedFiles, 'file', 'files')} left out for size`);
  if (report.skippedFiles > 0) lines.push(`${countLabel(report.skippedFiles, 'binary or very large file', 'binary or very large files')} left out`);
  if (report.unreadableFiles > 0) lines.push(`${count(report.unreadableFiles)} could not be read`);
  if (result.aiFailure) lines.push(`AI notes are incomplete: ${result.aiFailure}`);
  else if (report.manifest.ai === 'none') lines.push('Exported without AI notes');
  else if (report.manifest.ai === 'partial') lines.push('AI notes are incomplete');
  return lines;
}

// ---- cancelling ----

export function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

function stopIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The export was cancelled.', 'AbortError');
}

// ---- where the package goes ----

export interface ExportTarget {
  /** The name the file is saved under: the suggested one, or the one chosen in the save dialog. */
  fileName: string;
  sink: PackageSink;
  /** After the last byte: hands a package collected in memory to the browser as a download. */
  finish?(): void;
}

interface SaveDialogOptions { suggestedName?: string; types?: { description?: string; accept: Record<string, string[]> }[] }
type SaveWindow = Window & { showSaveFilePicker?: (opts?: SaveDialogOptions) => Promise<FileSystemFileHandle> };

/** Hand a blob to the browser as a download, the way `downloadModel` does. */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, fileName);
  // the download reads the blob after the click returns
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Start a download of something that already has a URL (the package a demo was opened from). */
export function downloadUrl(url: string, fileName: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
}

/** "react.starmap.zip" out of a package URL, for the download's name. */
export function fileNameOfUrl(url: string): string {
  const path = url.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || 'demo.starmap.zip';
}

function memoryTarget(fileName: string): ExportTarget {
  const sink = memorySink();
  return { fileName, sink, finish: () => downloadBlob(sink.blob(), fileName) };
}

/**
 * Where the package is written. With a save dialog (Chromium) the file streams to disk, so a large
 * package is never held in memory: the dialog must be opened from the click itself, before anything
 * is awaited. Without one the package is collected in memory and downloaded at the end. Resolves
 * null when the viewer closes the dialog.
 */
export async function chooseTarget(suggestedName: string): Promise<ExportTarget | null> {
  const pick = typeof window === 'undefined' ? undefined : (window as SaveWindow).showSaveFilePicker;
  if (typeof pick !== 'function') return memoryTarget(suggestedName);
  let handle: FileSystemFileHandle;
  try {
    handle = await pick.call(window, {
      suggestedName,
      types: [{ description: 'Starmap package', accept: { 'application/zip': ['.zip'] } }],
    });
  } catch (err) {
    if (isAbort(err)) return null;
    // the dialog would not open (the click was too long ago, or the page may not ask): download instead
    console.warn('starmap: the save dialog could not be opened; the package will be downloaded', err);
    return memoryTarget(suggestedName);
  }
  const stream = await handle.createWritable();
  return {
    fileName: handle.name,
    sink: {
      write: (chunk) => stream.write(chunk as Uint8Array<ArrayBuffer>),
      close: () => stream.close(),
      abort: (reason) => stream.abort(reason),
    },
  };
}

// ---- the AI step ----

export interface FinishAiOptions {
  ai: Pick<AiController, 'start' | 'requestDetail'>;
  /** The open map's annotations, read again after generation has put its own there. */
  annotations(): readonly Annotation[];
  /**
   * Asked before every call: the viewer's answer for this repo is still yes. Nothing is requested
   * once it is not.
   */
  allowed(): boolean;
  /** Before generation (`total` 0), then after every detail card. */
  onProgress?(done: number, total: number): void;
  signal: AbortSignal;
}

/**
 * Generate what is missing (summaries, points of interest, the tour), then every detail card that
 * has no answer yet, a few at a time. Never rejects: resolves with the first failure worth saying,
 * or null. The export goes on either way.
 */
export async function finishAi(opts: FinishAiOptions): Promise<string | null> {
  const { ai, signal } = opts;
  let failure: string | null = null;
  let failedInARow = 0;
  let stop = false;
  /** Runs one call; true when it ended without a failure. */
  const run = async (call: () => Promise<AiRunOutcome | void>): Promise<boolean> => {
    let failed: unknown = null;
    try { failed = (await call())?.failure ?? null; } catch (err) { failed = err; }
    if (!failed) { failedInARow = 0; return true; }
    const info = toAiErrorInfo(failed);
    // cancelled (AI was turned off meanwhile): the calls stop, and there is nothing to report
    if (info.code === 'aborted') { stop = true; return false; }
    failure ??= info.message;
    if (HOPELESS.has(info.code) || ++failedInARow >= GIVE_UP_AFTER) stop = true;
    return false;
  };
  const goOn = (): boolean => !stop && !signal.aborted && opts.allowed();

  if (!goOn()) return failure;
  opts.onProgress?.(0, 0);
  await run(() => ai.start());
  if (!goOn()) return failure;

  const all = opts.annotations();
  const todo = missingDetails(all);
  const total = all.filter((a) => a.type === 'poi').length * DETAIL_KEYS.length;
  let done = total - todo.length;
  opts.onProgress?.(done, total);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < todo.length && goOn()) {
      const card = todo[next++]!;
      if (await run(() => ai.requestDetail(card.poiId, card.question))) opts.onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAILS_IN_FLIGHT, todo.length) }, lane));
  return failure;
}

// ---- the export ----

export interface ExportOptions {
  /** The open map. It must have `readFiles`: a folder behind it. */
  session: Session;
  target: ExportTarget;
  /** Who finishes the AI work; null to export without it (AI is off, or not agreed to). */
  ai: Pick<AiController, 'start' | 'requestDetail'> | null;
  /** See `FinishAiOptions.allowed`. */
  aiAllowed(): boolean;
  /** One line saying what is being done, as it changes. */
  onStatus(line: string): void;
  signal: AbortSignal;
}

/**
 * Write the package of the open map to `target`. Rejects with an `AbortError` when cancelled and
 * with whatever went wrong otherwise; either way nothing is left open.
 */
export async function exportPackage(opts: ExportOptions): Promise<ExportResult> {
  const { session, target, signal } = opts;
  try {
    const read = session.readFiles?.bind(session);
    if (!read) throw new Error('There is no folder behind this map to pack files from.');

    let aiFailure: string | null = null;
    if (opts.ai) {
      aiFailure = await finishAi({
        ai: opts.ai,
        annotations: () => session.replica.annotations,
        allowed: opts.aiAllowed,
        onProgress: (done, total) => opts.onStatus(total > 0 ? detailLine(done, total) : 'Finishing the AI notes'),
        signal,
      });
      stopIfCancelled(signal);
    }

    opts.onStatus('Preparing the map');
    const model = await session.exportModel();
    stopIfCancelled(signal);
    const license = await licenseOf(read);
    stopIfCancelled(signal);
    const sourceUrl = sourceUrlOf(model.meta.remoteUrl);
    const { maxBytes, minLines } = session.config.demo.package;
    const report = await writePackage({
      model,
      info: { sourceUrl, license, ai: aiCompleteness(annotationsOf(model)) },
      read,
      sink: target.sink,
      maxBytes,
      minLines,
      // the same ceiling the parser reads to: a larger file is not text worth shipping
      maxFileBytes: session.config.parser.maxFileBytes,
      onProgress: (done, total, bytes) => opts.onStatus(packingLine(done, total, bytes)),
      signal,
    });
    target.finish?.();
    return { fileName: target.fileName, report, aiFailure, configLine: configLine(model.meta.name, target.fileName, sourceUrl) };
  } catch (err) {
    // writePackage aborts the sink itself when it fails; anything that stopped earlier left it open
    try { await target.sink.abort?.(err); } catch { /* already closed or aborted */ }
    throw err;
  }
}
