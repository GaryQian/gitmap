# Demo mode: plan

Four demos (Flutter, TensorFlow, React and this repo), each shipped as one packaged file that the app itself exports. Opening a demo downloads and unpacks that file; nothing is parsed and no model is called.

Status: decisions taken 2026-11-21 (§9); build in progress. Written against commit `2907085`.

## 1. What exists today, and what changes

| Today | After this plan |
|---|---|
| A demo is two files, `snapshot.starmap.json.gz` and `content.zip`, built by a Node script (`scripts/build-demo.ts`) | A demo is **one package file**, produced by the **Export button in the app** |
| The script's AI step is an empty hook, so demos would ship with no summaries, points of interest or tour | Export finishes the AI work first, including every detail card, so the package is complete |
| Export lives in the repo info card and writes the map only, with no file contents | Export moves to the settings card with two choices: the whole package, or the map only (the existing `.starmap.json.gz`) |
| Landing pill says "Demo"; the title pill top left does not | Both are labelled |
| `config.demo.repos` is empty | Four entries |

Kept as is: the zip reader in `src/content` (`zip.ts`), the `demo` source kind in the pipeline, "no AI consent prompt for demos", and history overlays read from stored per-file values. The range-request reader (`demoSource`) is replaced by the package reader.

## 2. The package file

One file per repo: `<name>.starmap.zip`. A plain zip, so it can be inspected with any tool.

| Entry | Contents |
|---|---|
| `starmap.json` | Small manifest: format version, repo name, source URL, commit, licence, file and byte counts, the app and parser version that wrote it, export time |
| `map.starmap.json.gz` | The model exactly as the app holds it: files, edges, cities, districts, settled layout, history overlay values, and all AI annotations (city summaries, points of interest with all four detail cards each, the tour) |
| `files/<path>` | The text of every file on the map, at the parsed commit, plus the repo's `LICENSE` / `NOTICE` files |

Rules:

- **Entry order is manifest, map, then files**, the archive is not zip64, and every entry's header carries its sizes. That lets the app read the map off the front of the download, show it after the first few megabytes, and take the files from the rest of the same response (§4).
- **Files can be trimmed.** A package has a size budget (`demo.package.maxBytes`) and an optional minimum line count (`demo.package.minLines`). Files are written most important first; once the budget is reached the rest are left out, so what is trimmed is the small and unimportant end. A trimmed file keeps its sphere on the map; the manifest counts how many were left out, and the sidebar says "This file is not included in the demo." when one is opened.
- **Contributor e-mail addresses are always stripped** from an exported package. Names stay so the Ownership picker works.
- **Not included:** `.git`, commit history, binary files, files over `parser.maxFileBytes`, and files edited since the parse (their bytes no longer match the map).
- **The file does not say "I am a demo".** A package is a demo when the app opens it from its demo list. The same file dropped on the landing page opens as an ordinary import. One format, two uses.

Expected sizes, from the pack measurements in PLAN.md §6.3.1 (estimates until the first export): React about 8 MB, Flutter about 36 MB, TensorFlow about 110 MB, this repo under 2 MB.

## 3. Export: the button in the settings card

A new row in the settings card: **Export**. It is enabled once a map is revealed.

Clicking it opens a short confirmation that says what will happen, then runs these steps with a progress line:

1. **Check the map is complete.** If the structure is still imports-only, or the history walk stopped at its cap, say so and offer to finish first ("Apply refined structure", "Load full history"). Exporting an incomplete map is allowed but named as such in the manifest.
2. **Finish the AI work.** Generate whatever is missing: city summaries, points of interest, the tour, and then **every detail card for every point of interest** (up to 15 points × 4 questions = 60 calls, which is exactly the per-repo detail limit already in config). This needs AI allowed for the repo and a key on the server; if AI is off, the dialog offers "Export without AI" and the manifest records it.
3. **Collect the files.** Read each file's committed bytes through the coordinator (the same pack reads the parser uses), skip binaries, and verify each against the blob id in the model.
4. **Write the zip.** Streamed, so TensorFlow's 250 MB of text is never held in memory at once: to disk through the browser's save dialog where available (Chromium), otherwise as an ordinary download.
5. **Report.** File name, size, counts, and the one line to add to `config.json`.

Export is refused for a map that is itself a demo or an import with no folder (there are no files to pack); for those the button re-downloads the package it was opened from.

## 4. Opening a demo

1. The landing page lists demos from `config.demo.repos`: `{ name, file, location }`, where `file` is the package's URL.
2. Clicking one opens a session with source kind `demo` pointing at the package URL.
3. **Download and unpack.** One request for the package. The manifest and the map are its first entries (a few megabytes even for TensorFlow); as soon as they have arrived the app loads the model and its saved layout and reveals, showing "Downloading demo 3.1 / 8.4 MB" on the waiting pill until then. No parsing, no settling.
4. **Files follow at once, as one download.** The rest of the same response is the files. They go on arriving in the background while the map is already on screen. A file opened in the sidebar before they are all in waits with a "Downloading the demo's files" line; afterwards every file opens instantly. Each file is checked against the model's blob id. A file that was trimmed from the package shows "This file is not included in the demo."
5. **Any static host works.** Nothing depends on range requests.
6. **Kept for next time.** The whole package is kept in the browser's cache with the host's validator (ETag, or modified time and size), so reopening is instant and works offline. A rebuilt package replaces the cached one.

In a demo: no AI calls and no consent prompt (everything is already in the file), overlays work from stored values, and Update, the working-tree check and "Load full history" are hidden.

## 5. Labelling

| Place | Today | Change |
|---|---|---|
| Landing page | Pill reads "react · Demo" in the same row as saved repos | Demos stay in the same row, sorted in with the saved repos by when each was last opened; each demo pill carries a "Demo" tag |
| Title pill, top left | App title and repo name | A "Demo" tag after the repo name |
| Repo info card | Says "Demo" | Also shows source URL, commit, licence and "Exported on …" from the manifest |
| Document title | Repo name | "react (demo)" |

## 6. A demo never blocks the same repo opened locally

The rule: **a demo's identity comes from the demo list, never from the repo's name or remote.**

- A demo's id is `demo:<name>`. A local clone's id comes from its remote or folder. They can never collide, so they never share a saved snapshot, a registry record, an AI consent answer or a facts cache.
- Demos are not written to the saved-repo registry at all (already true); they are listed from config only.
- The landing page shows both when both exist: "react · github.com/facebook/react" among saved repos and "react · Demo" among demos. Neither hides the other.
- Choosing a folder or dropping one always opens that folder, whatever demos exist.
- Dropping a package file opens it as an import, not as the demo of the same name.

Test for this (the one place it could silently go wrong): open the React demo, go back, choose a local React clone, and check it parses from disk, is saved under its own id, and both pills are still listed; then reopen the demo and check it did not pick up the local snapshot.

## 7. Work, in order

| # | Piece | Where | Notes |
|---|---|---|---|
| 1 | Package format: writer and reader, manifest type | `src/content/package.ts` | Streaming zip writer; reader reuses `zip.ts`; round-trip and "map entry readable from the first N bytes" tests |
| 2 | File collection for export | coordinator call + `src/pipeline` | Committed blobs from the pack, verified by blob id; binaries skipped; licence detection moved out of `build-demo.ts` into shared code |
| 3 | "Complete the AI" step | `src/pipeline/ai.ts`, `src/ai/client` | One call that generates anything missing and all detail cards, with progress and cancel; test against the canned provider |
| 4 | Export UI | `src/app/settings` (new row), remove the export from `src/app/repos/RepoInfo.tsx` | Two choices (package, map only), confirmation, progress, incomplete-map warnings, "Export without AI" |
| 5 | Demo loading from one package | `src/pipeline` (`loadDemo`), `src/content/demo.ts` | Progressive open, progress events, cache keyed by size and modified time; replaces the two-file loader |
| 6 | Labels | `src/app/repos`, `src/app/title` | "Demo" tags, demos sorted in with saved repos, info card fields |
| 7 | Identity test and import path | `src/app`, `tests/e2e` | The test in §6; dropping a package opens it with its files readable |
| 8 | Retire the old path | `scripts/build-demo.ts`, PLAN.md §12.1 | Delete the script or cut it down to a thin wrapper over the same writer; update the plan text |
| 9 | Wire the four demos | `config.json`, `public/demo/` or external hosting | After you supply the files |

Pieces 1–3 are independent and can be built in parallel; 4 needs 1–3; 5 needs 1; 6 and 7 need 5.

## 8. What you run, once the code is in

For each of the four repos, in Chromium, with `ANTHROPIC_API_KEY` set for the local server:

1. Check out the commit you want the demo to show, with a clean working tree.
2. Open the folder in the app and wait for the map.
3. If offered, apply the refined structure and load the full history.
4. Allow AI for the repo and let summaries, points of interest and the tour finish.
5. Settings → **Export**. It generates the detail cards, packs the files and saves `<name>.starmap.zip`.
6. Send me the four files (or put them in `public/demo/`), with the config lines the export printed.

Rough AI usage per repo: up to 20 city summaries on the small model, then points of interest, the tour and up to 60 detail cards on the large model.

## 9. Decisions (taken 2026-11-21)

| # | Question | Decision |
|---|---|---|
| 1 | Include the files' text in the package? | Yes. Small, unimportant files may be trimmed to a size budget; the sidebar then says the file is not included in the demo. |
| 2 | Where do packages over 100 MB live? | Not decided. The size budget defaults to 95 MB so that every package fits in the repo under GitHub's limit; raise it and host elsewhere if TensorFlow should ship untrimmed. |
| 3 | Licence for this repo | MIT. `LICENSE` added at the root. |
| 4 | Map-only export | Kept, as a second choice beside the package export. |
| 5 | Loading order | Map first, then all the files as one follow-up download (not one request per file). |
| 6 | Landing page | Demos are sorted in with the other pills, not given a row of their own. |

## 10. Risks

- **TensorFlow in the browser.** Reading 21k files and writing a 110 MB zip from a tab is the heaviest thing the app will have done. The streaming writer is what makes it feasible; if it is still too slow, the fallback is a Node wrapper over the same writer for that one repo.
- **TensorFlow's map itself.** At about 25k files it is past the 10k design size: the model file alone is about 3 MB and the reveal needs the scaled settle cap. The demo loads a saved layout, so it does not pay the settle cost, but frame rate on modest hardware is unmeasured.
- **Format drift.** A package records the parser and schema version. A demo built by an older build is refused cleanly ("this demo needs rebuilding") instead of loading wrongly; that means re-exporting the four files whenever the schema changes.
- **AI output is frozen into the file.** A poor summary ships until the package is rebuilt. The export confirmation is the moment to look at the tour and points of interest before saving.
