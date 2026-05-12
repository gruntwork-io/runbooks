# Per-Render Hot-Path Performance Refactor

## Context

A keystroke in a template form triggers this chain on every render:

1. IPC arrives at `electron/main/ipc/boilerplate.ts:render`.
2. Warm path (WASM) renders the dirty set into an in-memory `contentMap`.
3. If anything routes to cold, a tempdir is created and the cold subprocess
   fills in the gap. The tempdir is then walked by
   `buildManifestFromDirectory` (`src/domain/files/manifest.ts:84`) to hash
   every file.
4. `computeDiff` partitions paths into orphaned/created/modified/unchanged.
5. `applyDiffFromContent` writes the result.

Recent work parallelized the writes in `applyDiffFromContent` (created +
modified, concurrency 16). Two more hot-path bottlenecks remain, plus one
genuinely redundant pass.

## The three opportunities

### 1. `diff.unchanged` loop is still sequential

`src/domain/files/manifest.ts:309-324` (`applyDiffFromContent`) and
`src/domain/files/manifest.ts:252-259` (`applyDiff`) both walk every
unchanged file sequentially:

```ts
for (const relPath of diff.unchanged) {
  const fullPath = path.join(outputDir, relPath)
  const exists = yield* fs.exists(fullPath)
  if (!exists) { ... }
}
```

`unchanged` is the **largest** bucket on every render after the first —
typically every file the template produces. Each iteration pays one
sequential `fs.exists` syscall. For a 50-file template that's 50 sequential
stats per render.

### 2. `applyDiff` is fully sequential

`src/domain/files/manifest.ts:221-263` (`applyDiff`, the cold path) has
four loops, none parallelized:

- `diff.orphaned` → `fs.rm` + `cleanupEmptyParentDirs`
- `diff.created` → `copyFileForManifest`
- `diff.modified` → `copyFileForManifest`
- `diff.unchanged` → `fs.exists` + conditional `copyFileForManifest`

This codepath runs on the very first render of a template, and on any
render that lands entirely in cold (the bundle producer is the typical
case). `copyFileForManifest` is `readFileBuffer` → `mkdir -p` → `writeFile`
— three syscalls per file, sequential.

### 3. Double-read in `buildManifestFromDirectory` → contentMap fill

`buildManifestFromDirectory` (`src/domain/files/manifest.ts:84-105`) reads
+ hashes every file in the tempdir to build manifest entries, then throws
the content away. Immediately after, `boilerplate.ts:407-419` re-reads
exactly the files the warm path didn't already produce:

```ts
const coldEntries = yield* buildManifestFromDirectory(createdTempDir)
const missing = coldEntries.filter((e) => !contentMap.has(e.path))
const reads = yield* Effect.forEach(missing, (entry) =>
  fs.readFile(path.join(createdTempDir, entry.path)).pipe(
    Effect.map((content) => [entry.path, content] as const),
  ),
  { concurrency: 16 },
)
```

Two reads of the same file on the cold path, every render. On a 50-file
template with 30 cold files, that's 30 wasted reads.

## The other thing on this hot path

`buildManifestFromDirectory` itself walks files sequentially
(`src/domain/files/manifest.ts:93-101`). Same story as #1 and #2: one
`fs.readFile` per iteration, no concurrency.

## Plan

Do these in order. Each step is independent and ships independently.

### Step A: Parallelize `applyDiffFromContent`'s unchanged loop

Convert the existing loop to `Effect.forEach` at concurrency 16. The body
is already conditional, so the structure stays clear:

```ts
const restored = yield* Effect.forEach(
  diff.unchanged,
  (relPath) => Effect.gen(function* () {
    const fullPath = path.join(outputDir, relPath)
    const exists = yield* fs.exists(fullPath)
    if (exists) return 0
    if (!contents.has(relPath)) return 0
    yield* writeFromContent(relPath)
    return 1
  }),
  { concurrency: 16 },
)
written += restored.reduce((a, b) => a + b, 0)
```

Estimated win: ~10× speedup on the unchanged loop for ≥16 files.

### Step B: Parallelize `applyDiff`'s four loops

Apply the same `Effect.forEach { concurrency: 16 }` treatment to each of
the four loops in `applyDiff`. The orphan loop must stay distinct because
of `cleanupEmptyParentDirs` ordering — a directory cleanup that races
against a creation in a parent could thrash, but since orphans run *before*
creates and the cleanup walks upward from the deleted file, this should
be safe at 16-way concurrency. Worth testing.

Estimated win: ~3-5× on cold first-render. This runs on every fresh
template instance.

### Step C: Drop the TOCTOU `fs.exists` check (optional, evaluate)

On the hot path the file almost always exists, so the `fs.exists` is
paying N syscalls to save the same N writes. Two options:

- **Drop the check entirely** and always re-write unchanged files. Cost:
  N writes instead of N stats. Writes are higher cost than stats, so this
  loses unless we expect the user to delete files often.
- **Keep the check but batch it via `fs.statBatch`** (if such a thing
  existed — Node doesn't expose one). Skip.

Recommendation: keep the existence check, parallelize per Step A. The
TOCTOU is theoretical here — the only "other writer" is the user manually
deleting files, which is exactly what the check is for.

### Step D: Parallelize `buildManifestFromDirectory`

`src/domain/files/manifest.ts:93-101` — convert the `for` loop to
`Effect.forEach` at concurrency 16:

```ts
const fileEntries = walkEntries.pipe(Chunk.toArray).filter(e => e.isFile)
const entries = yield* Effect.forEach(
  fileEntries,
  (entry) => fs.readFile(entry.path).pipe(
    Effect.map((content) => ({
      path: entry.relativePath,
      contentHash: hashFileContent(content),
    } satisfies ManifestEntry)),
  ),
  { concurrency: 16 },
)
```

Estimated win: ~10× on the manifest-build phase of cold renders.

### Step E: Eliminate the double-read

The structural fix. `buildManifestFromDirectory` currently returns
`ManifestEntry[]` (path + hash). It already has the content in memory.
Change its signature to either:

**Option 1** — return content alongside the entry:

```ts
export interface ManifestEntryWithContent extends ManifestEntry {
  readonly content: Buffer
}

export function buildManifestFromDirectoryWithContent(rootDir: string)
  : Effect.Effect<ManifestEntryWithContent[], ..., FileSystem>
```

The existing `buildManifestFromDirectory` keeps its signature
(thin wrapper that strips `content`); callers that need the content
(`boilerplate.ts:render`) switch to the new function. The IPC handler then
populates `contentMap` from the returned entries directly — no second
`fs.readFile` pass.

**Option 2** — change `buildManifestFromDirectory` to take a callback or
yield entries via a Stream. More invasive. Skip unless we find a second
caller that wants partial results.

Recommendation: Option 1. ~30 lines of code, eliminates 30+ wasted reads
per cold render.

## Concurrency value

All five steps use `concurrency: 16`. Rationale:

- macOS default open-FD ulimit is 256; 16 leaves ample headroom even if
  multiple renders run concurrently across templates.
- Templates produce many small files (configs, scripts, READMEs). Higher
  concurrency wouldn't saturate the SSD any further.
- `Effect.forEach` aborts on first failure and interrupts siblings —
  error semantics are unchanged from sequential.

Future: extract `BATCH_IO_CONCURRENCY = 16` to a shared constant if a
third call site appears outside this refactor.

## Memory consideration

`contentMap` and the new `ManifestEntryWithContent[]` both hold every file's
content in memory simultaneously. For typical templates (~50 files × a few
KB each) this is trivial. If we ever see templates with hundreds of MB of
generated content, revisit by streaming through the diff/write pipeline.
Not a today problem.

## Validation

- `npx tsc --noEmit` after each step.
- Manual test: a typing-keystroke storm on a real runbook. Watch the
  `[ipc boilerplate:render] timing(ms)` log — `dCold`, `dDiff`, `dWrite`
  are the relevant numbers.
- Stretch: add a render-count counter to a perf-test runbook to baseline
  before/after on each step.

## Estimate

- Step A: 15 min
- Step B: 30 min (orphan-cleanup race needs a careful look)
- Step C: skip (decision documented above)
- Step D: 15 min
- Step E: 45-60 min (signature change touches `boilerplate.ts` and any
  other callers of `buildManifestFromDirectory`)

Total: ~2 hours for the full sweep, shippable as 4 commits.

## Out of scope

- React-side perf (Template.tsx `markStage`, memoization, ordering) — the
  IPC and disk path is where the measured ~200ms gap lives, per the
  existing perf annotations in `boilerplate.ts`.
- Bundle producer optimization — separate codepath, separate review.
- WASM render-call latency — owned by the boilerplate team.
