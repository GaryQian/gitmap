# The AI layer (`src/ai`)

Annotations written by a model: a summary of every city, points of interest, a tour, and on-demand answers about one point of interest (PLAN.md §11). Three parts:

| Part | Folder | Runs in | What it does |
|---|---|---|---|
| **Digest** | `digest/` | coordinator worker, Node | Builds the text the model sees from the replica and the parse facts: the repo digest, one context per city, one context per detail button. Deterministic; its hash keys stored results. |
| **Client** | `client/` | coordinator worker, Node; consent on the main thread | The typed HTTP client, the map → reduce sequence, the detail call, consent. Returns `ModelPatch` operations; never touches a store or the DOM. |
| **Server** | `server/` | the function runtime only (`api/ai/*`), tests | Four thin, stateless handlers: check size, call the provider, validate, drop what cites unknown references. |

`src/ai/index.ts` is the public surface and is browser-safe: digest, client, orchestration, consent, `estimateTokens`. It never imports `./server` (which pulls in the provider SDK); import `src/ai/server` directly from `api/`, scripts and tests.

The chrome's half is in `src/app/ai/` (consent prompt, failure line, detail-button wiring). It talks to the orchestration through a small controller, because the digest needs `FileFacts` and `SyntaxFacts`, which live only in the coordinator worker.

## What is generated

1. **Map:** one `summaries` call per city, four at a time. Each answer becomes a `Summary` annotation: `{ type: 'summary', id: 'summary:<cityId>', parent: 'c:<cityId>', label, text }`. **Summaries are user-visible**, not only context for the next step: `src/app/summaries/` shows `label` and `text` when the pointer rests on a city's pill, which is why the prompt asks what the city *does*, and why they are emitted as soon as the map step finishes, before the slower calls.
2. **Reduce:** `pois` (count from `poiCount`) and `tour`, both sent the digest, the summaries that succeeded and the digest's `refs`, byte-identical. The tour is sent `reduceHeadStartMs` after the points of interest (or when that call is over, if sooner) so it is served from the prompt cache the first one writes. One failing does not discard the other.
3. **On demand:** one `detail` call per button press, stored on the point of interest as `details[question]`: `loading` → `ready` (Markdown) or `error`. A file the digest withholds (secret-named, key-shaped content, vendored) is never sent: the detail becomes `ready` with a sentence saying so.

Rules the orchestration keeps:

- **Stored results are keyed by the digest hash** (`RepoMeta.digestHash`). What is stored for the current digest is not asked for again. A complete set (points of interest and a tour) makes no request, so `generateAnnotations` is safe to call on every visit. A run that lost a stage (rate limit, network) asks only for what is missing next time.
- A **new digest** replaces the old set: the first operations of the run remove the previous annotations and set the new hash. If nothing could be produced, the stored set and its hash are left alone.
- A point of interest or tour step whose parent is not a `u:` reference in the replica is dropped, here as well as on the server.
- `disabled`, `no_key`, `unavailable` and a cancelled signal stop the run at once; any other failure costs only its own call.
- Ids are stable: `summary:<cityId>`, `poi:<hash of parent and label>`, and one tour, `tour`.

## Wiring guide (for the lead)

### Coordinator worker

```ts
import { createAiClient, generateAnnotations, generateDetail } from '../ai';
import type { AiErrorInfo } from '../ai';

const client = createAiClient();            // same origin, /api/ai/*; `fetch` exists in workers
let aiAbort: AbortController | null = null;
const input = () => ({ replica: store.replica, files: state.facts, syntax: state.syntax, config: deps.config });

// three more CoordinatorCalls (src/pipeline/protocol.ts)
async aiStart(): Promise<{ failure: AiErrorInfo | null }> {
  await state.slowPass;                               // never on a provisional structure (PLAN.md §11.1)
  // A map shown from its snapshot has no facts in memory. Without them the digest would be a
  // different, poorer text with a different hash, and the stored set would be regenerated from it.
  if (!state.syntaxComplete || state.facts.length === 0) return { failure: null };
  aiAbort?.abort();
  aiAbort = new AbortController();
  const result = await generateAnnotations({
    input: input(),
    client,
    signal: aiAbort.signal,
    emit: (ops) => { store.propose(ops); },           // summaries first; the snapshot writer sees ordinary batches
    onProgress: ({ done, total }) => deps.emit('progress', { subsystem: 'ai', done, total }),
  });
  return { failure: result.failure };                 // resolve, do not throw: a rejected call keeps only its message
},
async aiDetail(poiId: string, question: DetailQuestion, fileText: string | null) {
  const poi = store.replica.annotations.find((a) => a.type === 'poi' && a.id === poiId);
  if (!poi || poi.type !== 'poi') return { failure: null };
  const result = await generateDetail({
    input: input(), poi, question, client,
    fileText: fileText ?? undefined,                  // sent in place of the skeleton when small enough
    emit: (ops) => { store.propose(ops); },           // `loading` at once, the outcome later
  });
  return { failure: result.error };
},
aiCancel() { aiAbort?.abort(); },
```

- `onProgress` always ends with `done === total`, so the shell's progress pill ("Writing notes") goes away however the run ends. A skipped run reports nothing.
- `emit` and `result.ops` carry the same operations: propose from one of them, not both.
- `generateDetail` reads the point of interest from `input.replica` again for each change, so proposing inside `emit` keeps two questions asked at once from overwriting each other.
- After "Apply" or "Update" the digest changes; calling `aiStart()` again regenerates for the new structure and removes the old set.

### Session (main thread)

`src/app/ai` looks for an optional `ai` property on the open `Session` (by shape, so the contract type did not have to change first):

```ts
// in createBrowserSession's returned object
ai: {
  get available() {
    return worker !== null && config.ai.enabled && source.kind !== 'demo'
      && source.kind !== 'synthetic' && !(source.kind === 'snapshot' && !source.locator);
  },
  start: () => call('aiStart'),
  async requestDetail(poiId, question) {
    const poi = replica.annotations.find((a) => a.type === 'poi' && a.id === poiId);
    let text: string | null = null;
    try { if (poi?.type === 'poi' && content) text = new TextDecoder().decode(await content.read(poi.parent)); } catch { /* the skeleton will do */ }
    return call('aiDetail', poiId, question, text);
  },
  cancel() { void call('aiCancel').catch(() => {}); },
},
```

That is all the chrome needs. It then:

- shows the consent card after the reveal when `shouldAsk(...)` is true and `ai.available`;
- calls `ai.start()` once per session whenever consent is `granted` (this visit or an earlier one);
- registers the detail requester of `src/app/poi` only with consent, so there is never a dead button;
- shows `failure` (or a rejection with a `code`) as one quiet line that fades.

`setAiController(controller)` from `src/app/ai` overrides the session's own controller (dev harness, screenshots). `getAiConsent`, `setAiConsent` and `resetConsent` are there for the settings card.

### Node (demo build, scripts)

No server is needed: hand the client a `fetch` that calls the handlers.

```ts
import { createAiClient, generateAnnotations, generateDetail } from '../src/ai';
import { createDeps, handlers } from '../src/ai/server';

const deps = createDeps(process.env);
const client = createAiClient({
  fetch: (async (url, init) => handlers[String(url).split('/').pop() as RouteName](new Request(`http://local${String(url)}`, init), deps)) as typeof fetch,
});
const { ops } = await generateAnnotations({ input, client });
store.propose(ops);
// demo snapshots ship every detail card: one generateDetail per point of interest and question
```

## Errors

Every failure is an `AiErrorInfo`: `{ code, message, retryAfterSeconds? }`, a plain object that survives `postMessage`. `code` is one of the server's (`disabled`, `no_key`, `too_large`, `rate_limited`, `refused`, `invalid`, `provider`) or the client's own (`network`, `unavailable` when the routes are not mounted, `aborted`, `failed`). `message` is one plain sentence for the chrome (`describeAiError`); the server's wording stays in `AiClientError.detail` for the console. `toAiErrorInfo(anything)` reads the code by shape, not by class.

The client retries nothing, except a `rate_limited` answer whose `retry-after` is at most `maxRetryAfterSeconds`, once.

## Consent

`getConsent(repoId)` / `setConsent(repoId, 'granted' | 'declined')` / `resetConsent(repoId)` over `localStorage` key `gitmap.ai.consent` (a JSON object, repo id → answer; storage can be injected). `shouldAsk({ config, meta, annotations, consent })` is true only when `config.ai.enabled`, the map is not a demo, no annotations with a digest hash are stored, and the viewer has not answered for this repo. The main thread cannot rebuild the digest, so "stored for the current digest" is settled in the worker: a set whose hash no longer matches is replaced there.

## Tunables waiting for a `config.json` entry

`client/tunables.ts`: `summaryConcurrency` (4), `reduceHeadStartMs` (3000), `maxRetryAfterSeconds` (5). `digest/tunables.ts` and `server/handlers.ts` (`LIMITS`) hold their own.
