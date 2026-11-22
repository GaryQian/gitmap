# The AI layer (`src/ai`)

Annotations written by a model: a summary of every city, points of interest, a tour, and on-demand answers about one point of interest (PLAN.md §11). Three parts:

| Part | Folder | Runs in | What it does |
|---|---|---|---|
| **Digest** | `digest/` | coordinator worker, Node | Builds the text the model sees from the replica and the parse facts: the repo digest, one context per city, one context per detail button. Deterministic; its hash keys stored results. |
| **Client** | `client/` | coordinator worker, Node; consent on the main thread | The typed HTTP client, the map → reduce sequence, the detail call, consent. Returns `ModelPatch` operations; never touches a store or the DOM. |
| **Server** | `server/` | the function runtime only (`api/ai/*`), tests | Four thin, stateless handlers: check size, call the provider, validate, drop what cites unknown references. |

`src/ai/index.ts` is the public surface and is browser-safe: digest, client, orchestration, consent, `estimateTokens`. It never imports `./server` (which pulls in the provider SDK); import `src/ai/server` directly from `api/`, scripts and tests.

The chrome's half is in `src/app/ai/` (the prompt at the bottom centre, the failure line, the detail-button wiring, the settings card's "AI notes" row). It talks to the orchestration through a small controller, because the digest needs `FileFacts` and `SyntaxFacts`, which live only in the coordinator worker.

## What is generated

1. **Map:** one `summaries` call per city, four at a time. Each answer becomes a `Summary` annotation: `{ type: 'summary', id: 'summary:<cityId>', parent: 'c:<cityId>', label, text }`. **Summaries are user-visible**, not only context for the next step: `src/app/summaries/` shows `label` and `text` when the pointer rests on a city's pill, which is why the prompt asks what the city *does*, and why they are emitted as soon as the map step finishes, before the slower calls.
2. **Reduce:** `pois` (count from `poiCount`) and `tour`, both sent the digest, the summaries that succeeded and the digest's `refs`, byte-identical. The tour is **one** request. The two are written by different model tiers (see the table under Providers), and a prompt cache is per model, so they are sent together as soon as the summaries are in. Only when `synthesis` and `tour` are configured with the same model id is the tour sent `reduceHeadStartMs` after the points of interest (or when that call is over, if sooner), so it is served from the cache the first one writes (`reduceHeadStart` in `client/generate.ts`). One failing does not discard the other.
3. **On demand:** one `detail` call per button press, stored on the point of interest as `details[question]`: `loading` → `ready` (Markdown) or `error`. A file the digest withholds (secret-named, key-shaped content, vendored) is never sent: the detail becomes `ready` with a sentence saying so.

**Prose says what the code does.** City summaries, point-of-interest summaries and tour steps never state counts or measurements (how many links, imports, dependents; fan-in, fan-out, weights): the digest's figures are for choosing what to write about, and the one place a structural fact is quoted is a point of interest's `evidence`. The prompts say so (`server/prompts.ts`), and the server checks it (`server/prose.ts`): a sentence that counts links or dependencies is a rule violation, quoted to the model on the one retry; if it comes back, that sentence is removed and the item kept when at least a few words remain (`LIMITS.minWordsLeft`), dropped otherwise. The trigger is a count of links or dependencies, not any number: "handles two kinds of request" is left alone.

Rules the orchestration keeps:

- **Stored results are keyed by the digest hash** (`RepoMeta.digestHash`). What is stored for the current digest is not asked for again. A complete set (points of interest and a tour) makes no request, so `generateAnnotations` is safe to call on every visit. A run that lost a stage (rate limit, network) asks only for what is missing next time.
- A **new digest** replaces the old set: the first operations of the run remove the previous annotations and set the new hash. If nothing could be produced, the stored set and its hash are left alone.
- A point of interest or tour step whose parent is not a `u:` reference in the replica is dropped, here as well as on the server.
- `disabled`, `no_key`, `unavailable` and a cancelled signal stop the run at once; any other failure costs only its own call.
- Ids are stable: `summary:<cityId>`, `poi:<hash of parent and label>`, and one tour, `tour:v<TOUR_VERSION>`.
- **The tour's id carries the version of its instructions** (`TOUR_VERSION` in `client/generate.ts`). A stored tour of another version counts as missing: on the next run for the same digest only `tour` is requested, and the old tour is removed in the same operations that set the new one (it stays if the request fails). Bump the version when the tour prompt changes enough that stored tours should be rewritten. Summaries and points of interest have no version of their own: they are rewritten when the digest hash changes.

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

That is all the chrome needs. It then (`src/app/ai`; the rules are pure functions in `rules.ts` and `flow.ts`, with tests):

- keeps one prompt at the bottom centre for as long as AI could write notes here and is not doing so: the consent card while the viewer has not answered (and nothing is stored), afterwards one pill: "Add AI notes" after "Not now", "Turn on AI notes" when notes from an earlier visit are on the map, "Write AI notes" when AI is on but the last run left nothing (it calls `ai.start()` again). Nothing while notes are being written or are there with AI on;
- calls `ai.start()` once per session whenever consent is `granted` (this visit or an earlier one);
- registers the detail requester of `src/app/poi` only with consent, so there is never a dead button;
- shows `failure` (or a rejection with a `code`) as one quiet line that fades;
- offers an "AI notes" On / Off row in the settings card (`AiSettingsRow`, rendered by `src/app/settings`). **Off** stores `declined`, calls `ai.cancel()` once and unregisters the detail requester; notes already written stay. **On** stores `granted` and calls `ai.start()`. No call reaches the controller unless the stored answer is `granted`, and work the `ai` subsystem reports while it is off is cancelled again.

What "Off" needs from the wiring: `cancel()` must stop a `start()` that has not begun its requests yet (one still waiting for the slow pass), and a detail request in flight (pass a signal to `generateDetail`; on abort it puts the detail back to `idle` itself).

`setAiController(controller)` from `src/app/ai` overrides the session's own controller (dev harness, screenshots). `getAiConsent`, `setAiConsent`, `resetConsent` and `switchAi(session, controller, 'on' | 'off')` are there for other features.

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

### Dev server and deployment

Nothing to add. `vite.config.ts` already mounts `POST /api/ai/{summaries,pois,tour,detail}` in the dev server (the `ai-dev-routes` plugin, which loads `src/ai/server` through the dev server and reads the selected provider's key from the environment or a `.env` file; see Providers below), and `api/ai/*.ts` are the deployed functions. `createAiClient()` defaults to that base, `/api/ai`. Without a key the handlers answer `no_key`, which the chrome shows as "No AI key is configured on the server."

## Providers

Two adapters implement `AiProvider` (`src/contracts/ai.ts`): Anthropic (`server/provider.ts`, the SDK) and OpenAI (`server/openai.ts`, the Responses API over plain `fetch`).

- **Selecting one.** The provider id is `VITE_AI_PROVIDER`, then `AI_PROVIDER`, then `config.json → ai.provider`, trimmed and lower-cased (`resolveProviderId`). Set `VITE_AI_PROVIDER`: it is the one the page can also read, so the digest hash includes the right provider and the reduce step knows whether its two calls share a model. (The chrome does not name the provider anywhere.) On Vercel it has to be set for the build and for the functions.
- **Variables.** `anthropic` needs `ANTHROPIC_API_KEY`; `openai` needs `OPENAI_API_KEY`. Keys are read only on the server. A missing key is answered as `no_key`, naming the variable; an unknown id as `provider`. `.env.example` lists them with the optional switches.
- **Models: three tiers, one per kind of task.** Each provider has its own block in `config.json`: `ai.models` (Anthropic) and `ai.openaiModels` (OpenAI). The handler sets the role of each route (`ModelRole`, `src/contracts/ai.ts`) and the adapter maps it to that block's model id (`tierModels` in `active.ts`):

  | Tier (config key) | Written with it | Route | Anthropic default | OpenAI default |
  |---|---|---|---|---|
  | `bulk`, the cheapest | one summary per city | `summaries` | `claude-haiku-5-5` | `gpt-6-luna` |
  | `tour`, the mid tier | the tour, in a single call | `tour` | `claude-sonnet-5-5` | `gpt-6.1-terra` |
  | `synthesis`, the most capable | points of interest; detail answers | `pois`, `detail` | `claude-opus-5-5` | `gpt-6.2-astra` |

  A block without a `tour` key keeps the tour on the `synthesis` model. The Anthropic adapter counts tokens with the `synthesis` model. (`chat` is a fourth key, for the chat assistant in `src/ai/chat`; without it the `tour` model is used.)
- **`activeAi(config, env?)`** (`active.ts`, exported from `src/ai`, browser-safe) returns `{ provider, name, models }` for the provider in use, `models` being the ids above. `digestHash` mixes in the provider id and the three ids `synthesis`, `tour` and `bulk`, so switching provider, or changing any one tier's model, regenerates the annotations instead of reusing another model's. The hash is one key for the whole set: changing only the tour's model rewrites the summaries and the points of interest too.
- **OpenAI specifics.** The system prompt is the first `developer` message, `cachedPrefix` is the first part of the user message with an explicit cache breakpoint at its end, and the prompt follows it; the result format is `text.format` with `strict: true`. The server's schemas meet the strict rules as written (`strictSchemaIssues` checks, and a test holds them to it); a schema that does not is sent with `strict: false` and the reply's shape is checked locally. Requests are sent with `store: false`. `countTokens` is the local estimate.
- **Adding another.** Write `server/<name>.ts` exporting a `create<Name>Provider({ apiKey, config, fetch? })` that returns an `AiProvider`: refusals, truncation and unusable output are `outcome` values, HTTP and network failures are thrown as `AiError` (`rate_limited` with a `retry-after` header, otherwise `provider`), and no message quotes the key. Add a case to `getProvider` (`server/provider.ts`) with the key's variable, a case to `activeAi` with the display name and the models block, and ask the lead for that block in `config.json`.

## Errors

Every failure is an `AiErrorInfo`: `{ code, message, retryAfterSeconds? }`, a plain object that survives `postMessage`. `code` is one of the server's (`disabled`, `no_key`, `too_large`, `rate_limited`, `refused`, `invalid`, `provider`) or the client's own (`network`, `unavailable` when the routes are not mounted, `aborted`, `failed`). `message` is one plain sentence for the chrome (`describeAiError`); the server's wording stays in `AiClientError.detail` for the console. `toAiErrorInfo(anything)` reads the code by shape, not by class; a plain object that already carries its own sentence (an outcome sent over from the coordinator) keeps it, while an Error is always described from its code.

The client retries nothing, except a `rate_limited` answer whose `retry-after` is at most `maxRetryAfterSeconds`, once.

## Consent

`getConsent(repoId)` / `setConsent(repoId, 'granted' | 'declined')` / `resetConsent(repoId)` over `localStorage` key `starmap.ai.consent` (a JSON object, repo id → answer; storage can be injected). `shouldAsk({ config, meta, annotations, consent })` is true only when `config.ai.enabled`, the map is not a demo, no annotations with a digest hash are stored, and the viewer has not answered for this repo: the case of the full consent card. What is shown in every other case (the pill that stands in for the card, the settings row) is decided by `aiPrompt` and `aiRow` in `src/app/ai/rules.ts`, which build on it. The main thread cannot rebuild the digest, so "stored for the current digest" is settled in the worker: a set whose hash no longer matches is replaced there.

## Chat

The chat assistant (PLAN.md §11.5) answers questions about the open repository and can drive the map. The repository exists only in the page, so **tools run in the page**: the model's tool calls come back in the reply, the page runs them and sends the results with the next request. The server stays a stateless proxy. The tool catalogue has MCP's tool shape, but there is no MCP server: a provider could not reach one.

| Part | File | What it does |
|---|---|---|
| Contract | `chat/types.ts`, `chat/tools.ts` | Messages, the event stream, `ToolExecutor`, and the fifteen tools (`CHAT_TOOLS`). Shared with `src/app/chat`, which implements the executor and the panel. |
| Overview | `chat/context.ts` | `buildChatContext(replica)`: repo name, size, languages, each city with ref, name, size, districts and stored summary. Deterministic, so it is a cacheable prefix; about `contextTokens` at most. |
| Transport | `chat/stream.ts` | `readSse` (a server-sent-event reader over a `ReadableStream`) and `createChatClient`, which POSTs a conversation and yields `ChatEvent`s; every failure is an `AiClientError`. |
| Loop | `chat/loop.ts` | `runChatTurn`: one user message to its answer. |
| Route | `server/chat.ts`, `api/ai/chat.ts` | `handlers.chat`: validate, rate-limit, size-check, open the provider stream, pass it on as server-sent `ChatEvent`s. |
| Adapters | `server/chatAnthropic.ts`, `server/chatOpenai.ts` | One `ChatProvider` each: `streamChat(request)` resolves to the events of one step. |
| Prompt | `server/chatPrompt.ts` | The system prompt, and the block that labels the overview as data. |

**Calling it from the page:**

```ts
import { buildChatContext, runChatTurn } from '../ai';
import type { ChatMessage, ChatTurnEvent } from '../ai';

const context = buildChatContext(session.replica);       // once per map; keep the string so the prefix stays cached
let history: ChatMessage[] = [];                         // the model's side of the conversation, for this visit

async function ask(text: string, stop: AbortSignal) {
  const { messages, summary } = await runChatTurn({
    messages: [...history, { role: 'user', text }],
    context,
    executor,                                            // src/app/chat: runs each tool call against the open map
    signal: stop,                                        // the Stop button
    onEvent: (e: ChatTurnEvent) => { /* 'step' | 'text' | 'tool_call' | 'tool_result' | 'trimmed' */ },
  });
  history = messages;                                    // always a conversation the next turn can continue from
  // summary.reason: 'end' | 'refusal' | 'max_tokens' | 'step_limit' | 'aborted' | 'error'
  // summary.notice: a sentence for the transcript when it is not 'end' or 'aborted'; summary.error: AiErrorInfo
}
```

`runChatTurn` never rejects. `history` is what the model is sent, not the transcript: when the conversation outgrows `historyTokens` the oldest turns are dropped from it (whole turns, so an assistant step keeps its tool results), a `trimmed` event says so, and the panel keeps showing what it showed. A turn that alone is too large has its older tool results replaced by a short note.

**A step on the wire.** `POST /api/ai/chat` with `{ context, messages }` (the whole conversation). The answer is `text/event-stream`, one `data: <ChatEvent>` per event: `text` deltas as they arrive, each `tool_call` once its arguments are complete, then one `done` with the stop reason (`end`, `tool_calls`, `max_tokens`, `refusal`) and the usage. A failure before the stream starts is the usual JSON error body and status (`invalid`, `too_large`, `rate_limited`, `no_key`, a provider that refuses the request); a failure after that is an `error` event and the end of the body. The loop runs tools only for a step that ended in `tool_calls`.

**What the server checks.** Sizes (`CHAT_LIMITS` in `server/chat.ts`), tool names against the catalogue, and the order of the conversation: it starts with a user message, every assistant step with tool calls is followed by a tool message answering the same ids in the same order, and it does not end on an assistant message. Then the same gate as the other routes: `ai.enabled`, the key, `LIMITS.ip` per address, and `ai.maxInputTokens` by the shared estimate over everything the model is sent. A tool call from the model for a name outside the catalogue ends the step with an `error` event.

**Providers.** `resolveProviderId` picks the adapter, as for the other routes; `createDeps` puts it in `deps.chat` (the JSON routes keep `deps.provider`). The model is `chat` in the provider's block of `config.json`, then `tour`, then `synthesis` (`chatModel`). The system prompt, the tool list and the overview are the cached prefix on both: on Anthropic a breakpoint on the overview (the last system block) plus the automatic breakpoint at the end of the conversation; on OpenAI they are the opening developer message, which automatic caching covers, and requests are sent with `store: false`. Effort is `low` on both (`CHAT_TUNABLES.effort`). Neither adapter replays the model's own reasoning between steps (thinking blocks, reasoning items): the neutral messages have no field for it.

**Not exercised against a live API.** Both adapters are tested against fake transports that speak the documented stream formats; neither has made a real call.

## Tunables

`config.json → ai.client` holds `summaryConcurrency`, `reduceHeadStartMs` and `maxRetryAfterSeconds`; the pipeline passes them in (`timing`, `createAiClient`). `client/tunables.ts` keeps the same values as the defaults for callers that pass none (tests, scripts). Still waiting for a `config.json` entry: `digest/tunables.ts` and `server/handlers.ts` (`LIMITS`). The chat assistant's are in `chat/tunables.ts` (`maxSteps` 8, `resultChars` 12000, `historyTokens` 60000, `contextTokens` 4000, `maxOutputTokens` 16000, `effort` low) and `server/chat.ts` (`CHAT_LIMITS`).
