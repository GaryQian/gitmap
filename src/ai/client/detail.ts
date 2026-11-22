// One detail button (PLAN.md §11.1, "on demand"): a focused context for one point of interest and one
// question, answered as Markdown and stored on the point of interest itself.
//
// The answer travels through the model: `poi.details[question]` goes to `loading`, then to `ready`
// (with the Markdown) or `error`. A file the digest builder withholds (secret-named, key-shaped
// content) is never sent: the detail becomes `ready` with a sentence saying so, and no request is made.
import type { DetailQuestion } from '../../contracts/ai';
import type { ModelPatch, Poi, PoiDetail } from '../../model/types';
import { buildDetailContext, buildDigest } from '../digest';
import type { DetailContext, DigestInput } from '../digest';
import { toAiErrorInfo } from './errors';
import type { AiErrorInfo } from './errors';
import type { AiClient } from './http';

export interface DetailOptions {
  input: DigestInput;
  poi: Poi;
  question: DetailQuestion;
  client: AiClient;
  /** The file's text, when the caller could read it. Sent in place of the skeleton if it is small enough. */
  fileText?: string;
  signal?: AbortSignal;
  /**
   * Called with each change as it happens: `loading` at once, the outcome later. Propose them to the
   * store here, or propose `ops` from the result at the end (the card then shows no stored `loading`).
   */
  emit?: (ops: ModelPatch[]) => void;
  /** Default: `input.replica.meta.digestHash`; the digest is built to get it when the model has none. */
  digestHash?: string;
}

export interface DetailResult {
  /** Everything emitted, in order. */
  ops: ModelPatch[];
  /** Where the detail ended up. `idle` after a cancelled request. */
  status: PoiDetail['status'];
  /** Why no request was made, or null when one was. */
  withheld: DetailContext['withheld'];
  /** The failure behind an `error` status, for a line in the chrome. */
  error: AiErrorInfo | null;
}

/** What the card says in place of an answer when nothing of the file may be sent. */
export function withheldMessage(why: NonNullable<DetailContext['withheld']>): string {
  switch (why) {
    case 'secret': return 'This file was withheld from the AI model because it looks like it holds secrets, so no answer was requested.';
    case 'excluded': return 'This file was withheld from the AI model because it is vendored or generated, so no answer was requested.';
    case 'unknown': return 'This file is no longer on the map, so no answer was requested.';
  }
}

export async function generateDetail(options: DetailOptions): Promise<DetailResult> {
  const { input, poi, question, client, signal } = options;
  const ops: ModelPatch[] = [];
  /**
   * The point of interest as the model has it now, with this one detail changed. Read again for
   * every change, so two questions answered at the same time do not overwrite each other.
   */
  const put = (detail: PoiDetail) => {
    const stored = input.replica.annotations.find((a): a is Poi => a.type === 'poi' && a.id === poi.id) ?? poi;
    const op: ModelPatch = { op: 'annotation', action: 'set', value: { ...stored, details: { ...stored.details, [question]: detail } } };
    ops.push(op);
    options.emit?.([op]);
  };

  const context = buildDetailContext(input, poi, options.fileText === undefined ? {} : { fileText: options.fileText });
  if (context.withheld) {
    put({ status: 'ready', markdown: withheldMessage(context.withheld) });
    return { ops, status: 'ready', withheld: context.withheld, error: null };
  }

  put({ status: 'loading' });
  try {
    const digestHash = options.digestHash ?? input.replica.meta?.digestHash ?? (await buildDigest(input)).hash;
    const res = await client.detail({
      digestHash,
      refs: context.refs,
      poi: { parent: poi.parent, label: poi.label, summary: poi.summary },
      question,
      context: context.context,
    }, { signal });
    put({ status: 'ready', markdown: res.markdown });
    return { ops, status: 'ready', withheld: null, error: null };
  } catch (err) {
    const error = toAiErrorInfo(err);
    if (error.code === 'aborted') {
      // cancelled: back to a button that can be pressed again, not a stored spinner or a failure
      put({ status: 'idle' });
      return { ops, status: 'idle', withheld: null, error: null };
    }
    if (error.code === 'failed') console.warn('starmap: AI detail failed', err);
    put({ status: 'error' });
    return { ops, status: 'error', withheld: null, error };
  }
}
