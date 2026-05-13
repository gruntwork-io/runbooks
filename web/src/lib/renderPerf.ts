/**
 * Per-render timing instrumentation for the Template auto-render pipeline.
 *
 * The pipeline collapses keystrokes via several debounces before invoking the
 * boilerplate render IPC. To debug where the latency lives, we stamp a wall-
 * clock time on each keystroke and log deltas at every stage along the way
 * (form debounce, auto-render effect, IPC debounce, IPC send, response,
 * paint).
 *
 * Cross-process: we use `Date.now()` so the main process can log deltas with
 * the same origin. `performance.now()` would be more precise but its epoch
 * differs per process, so we'd need a clock sync that isn't worth the cost
 * for ~1s scale measurements.
 *
 * The "active keystroke" model: a new keystroke resets the start time. The
 * debounces in the pipeline guarantee that only the last keystroke in a burst
 * produces a render, so all subsequent stages naturally measure from the user's
 * last edit. Concurrent in-flight traces across different forms are not
 * supported — there's exactly one active trace at a time.
 *
 * Disabled by default. Toggle via either:
 *   - localStorage.setItem('runbooks:renderPerf', '1')
 *   - process.env.RUNBOOKS_RENDER_PERF=1  (main process)
 */

export interface RenderPerfPayload {
  seq: number
  keystrokeAt: number
  sentAt?: number
}

const STORAGE_KEY = "runbooks:renderPerf"

let activeKeystrokeAt: number | null = null
let activeSeq = 0

function isEnabled(): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(STORAGE_KEY) === "1"
    }
  } catch {
    // Access can throw in sandboxed contexts; treat as disabled.
  }
  return false
}

/** Stamp a new keystroke as the start of a perf trace. Returns the new sequence number. */
export function markKeystroke(): number {
  activeSeq += 1
  activeKeystrokeAt = Date.now()
  if (isEnabled()) {
    console.log("[perf]", `seq=${activeSeq}`, "keystroke", "+0ms")
  }
  return activeSeq
}

/** Log a stage delta against the active keystroke. No-op if no keystroke is active. */
export function markStage(name: string, meta?: Record<string, unknown>): void {
  if (!isEnabled() || activeKeystrokeAt == null) return
  const delta = Date.now() - activeKeystrokeAt
  if (meta) {
    console.log("[perf]", `seq=${activeSeq}`, name, `+${delta}ms`, meta)
  } else {
    console.log("[perf]", `seq=${activeSeq}`, name, `+${delta}ms`)
  }
}

/** Build the payload that travels with the IPC request so the main process can correlate logs. */
export function getPerfPayload(): RenderPerfPayload | undefined {
  if (!isEnabled() || activeKeystrokeAt == null) return undefined
  return {
    seq: activeSeq,
    keystrokeAt: activeKeystrokeAt,
    sentAt: Date.now(),
  }
}

/** True if perf tracing is currently enabled. Cheaper than a string parse at callsites. */
export function isPerfEnabled(): boolean {
  return isEnabled()
}
