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
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a debounced file watcher stream for a runbook.
 *
 * Watches the parent directory of `runbookPath` (so editors that save by
 * writing a temp file and renaming it over the original are still seen) and
 * emits FileChangeEvent items for "add" and "change" events on the runbook
 * file only. Everything else under that directory -- generated output, cloned
 * repos, .git, node_modules -- is ignored.
 *
 * The stream is debounced: after a burst of changes, only the
 * last event within the 300ms window is emitted.
 */
export const createWatcher = (
  runbookPath: string,
): Effect.Effect<Stream.Stream<FileChangeEvent, FileWatchError>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const runbookFile = path.resolve(runbookPath)
    const watchDir = path.dirname(runbookFile)

    // Filter to write/create events on the runbook itself, then debounce.
    // Filtering first keeps an unrelated write that lands in the same window
    // from replacing (and so swallowing) the runbook's event.
    return pipe(
      fs.watch([watchDir]),
      Stream.filter(
        (event) =>
          (event.type === "add" || event.type === "change") &&
          path.resolve(event.path) === runbookFile,
      ),
      Stream.debounce(DEBOUNCE_MS),
    )
  })
