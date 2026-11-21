# Spike: read blobs from the packfile instead of opening each file

**Question.** Spike 1 found that per-file opens dominate the fast pass. Is reading the same content out of `.git/objects/pack/*.pack` faster?

**Method.** `npx tsx io/packblobs.ts <repo> [pageSize] [offset|path] [tree|pack]`. Node 24, Windows 11, one thread, warm OS cache. Same file filter as spike 1 (code files by extension, ≤ 1 MB, regular files). Uses the fork's `git/core/odb.ts` (pack index v2, 64 KB page cache, `fflate` inflate, delta resolution) with a 256 MB object cache. Baseline is `fs.readFileSync` per file.

## Results

| Repo | Files | Raw MB | Open each file | Read from pack | Index load | I/O calls | I/O ms | I/O MB | Inflate ms | Delta ms | Avg / max chain |
|---|---|---|---|---|---|---|---|---|---|---|---|
| react | 4,590 | 26.4 | 2,177 ms | **203 ms** | 33 ms | 118 | 7 | 7.7 | 181 | 5 | 1.01 / 2 |
| flutter | 11,314 | 124.8 | 5,578 ms | **1,002 ms** | 189 ms | 551 | 35 | 36.1 | 789 | 146 | 1.18 / 34 |
| tensorflow | 21,453 | 246.9 | 10,081 ms | **1,981 ms** | 344 ms | 1,633 | 96 | 107.1 | 1,607 | 179 | 1.10 / 7 |

- Pack read is 5–10× faster single-threaded. Disk I/O is 3–5% of the pack path; inflate is about 80%.
- Compressed size of the needed blobs: 5.1 / 10.7 / 27.2 MB.
- Variants on flutter: 1 MB pages → 50 I/O calls, 51.7 MB read, 33 ms I/O (no gain when warm). Path order instead of offset order → no difference when warm. Running the pack read before the tree read did not change either number.
- Correctness sample (~300 files per repo): every blob equals the working-tree file exactly or after CRLF → LF (react: all CRLF in the working tree; tensorflow: all identical). No mismatches.
- All index blobs were found in packs in all three repos; zero loose objects.

## Not measured

- Browser read paths: per-file File System Access calls, and `FileReaderSync` on `File.slice` for pack pages.
- Cold OS cache.
- Repos with many loose objects, partial clones, or unstaged working-tree edits.
- Multi-worker scaling of inflate.

## Conclusion

Read content from the pack and fall back to the working tree per file. The bottleneck moves from file opens to decompression, which is CPU and parallelises.
