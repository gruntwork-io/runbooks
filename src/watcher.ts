/**
 * Watches a runbook file for write/create events, debounced at 300ms to
 * coalesce rapid changes (e.g. editor save + format).
 */
import * as path from "path"
import { Effect, Stream, pipe } from "effect"
import { FileSystem, type FileChangeEvent } from "./services/FileSystem.ts"
import type { FileWatchError } from "./errors/index.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window in milliseconds for rapid file changes. */
const DEBOUNCE_MS = 300

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether two absolute paths name the same file. macOS and Windows file
 * systems are case-insensitive by default: a runbook opened by directory
 * resolves to "runbook.mdx", while the watcher reports the on-disk name
 * (e.g. "Runbook.mdx").
 */
const isSameFile = (a: string, b: string, platform: NodeJS.Platform): boolean =>
  platform === "darwin" || platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a debounced file watcher stream for a runbook.
 *
 * Watches the directory that contains `runbookPath` (so editors that save by
 * writing a temp file and renaming it over the original are still seen) and
 * emits FileChangeEvent items for "add" and "change" events on the runbook
 * file only. Subdirectories -- generated output, cloned repos, .git,
 * node_modules -- are not watched at all, and events for the directory's
 * other files are dropped.
 *
 * The stream is debounced: after a burst of changes, only the
 * last event within the 300ms window is emitted.
 */
export const createWatcher = (
  runbookPath: string,
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<Stream.Stream<FileChangeEvent, FileWatchError>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const runbookFile = path.resolve(runbookPath)
    const watchDir = path.dirname(runbookFile)

    // Filter to write/create events on the runbook itself, then debounce.
    // Filtering first keeps an unrelated write that lands in the same window
    // from replacing (and so swallowing) the runbook's event.
    return pipe(
      fs.watch([watchDir], { depth: 0 }),
      Stream.filter(
        (event) =>
          (event.type === "add" || event.type === "change") &&
          isSameFile(path.resolve(event.path), runbookFile, platform),
      ),
      Stream.debounce(DEBOUNCE_MS),
    )
  })
