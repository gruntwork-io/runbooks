/**
 * File watcher ported from api/watcher.go.
 *
 * Watches the directory containing a runbook file for write/create events,
 * debounced at 300ms to coalesce rapid changes (e.g. editor save + format).
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
 * Watches the parent directory of `runbookPath` and emits
 * FileChangeEvent items for "add" and "change" events only
 * (matching the Go version's Write + Create filter).
 *
 * The stream is debounced: after a burst of changes, only the
 * last event within the 300ms window is emitted.
 */
export const createWatcher = (
  runbookPath: string,
): Effect.Effect<Stream.Stream<FileChangeEvent, FileWatchError>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const watchDir = path.dirname(path.resolve(runbookPath))

    const rawStream = fs.watch([watchDir])

    // Filter to write/create events only, then debounce.
    const filtered = pipe(
      rawStream,
      Stream.filter((event) => event.type === "add" || event.type === "change"),
      Stream.debounce(DEBOUNCE_MS),
    )

    return filtered
  })
