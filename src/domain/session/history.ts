/**
 * A session's history: what the user did to the runbook's blocks, in order.
 *
 * A block adds an event whenever the user acts on it. The event has the
 * block's state after the action, so the latest event of each kind is what a
 * resumed session shows the block as. The renderer decides what a payload
 * holds (web/src/lib/sessionHistory.ts); here it is JSON of a bounded size.
 */
import { Effect } from "effect"
import { SessionEventError } from "../../errors/index.ts"

/**
 * What an event records:
 *
 *  - `inputs`: the values of a form, and whether it was submitted.
 *  - `run`: a script run starting or ending, with its status, logs and outputs.
 *  - `render`: a template writing its files, as a hash of what it wrote.
 *  - `clone`: a repository cloned or selected, or given up.
 *  - `pull-request`: a pull or merge request opened, or set aside for another.
 *  - `auth`: a sign-in, or a sign-out.
 */
export const SESSION_EVENT_KINDS = [
  "inputs",
  "run",
  "render",
  "clone",
  "pull-request",
  "auth",
] as const

export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number]

/** Block ids come from the runbook, which may be someone else's. */
export const SESSION_EVENT_BLOCK_ID_MAX_LENGTH = 256

/** The most JSON one event's payload may be, in characters. */
export const SESSION_EVENT_PAYLOAD_MAX_LENGTH = 1024 * 1024

/** An event as a block reports it. */
export interface SessionEventRequest {
  blockId: unknown
  kind: unknown
  payload: unknown
}

export interface SessionEvent {
  blockId: string
  kind: SessionEventKind
  /** The block's state after the event, as JSON. */
  payload: string
}

/** A block's latest state of one kind, as a resumed session restores it. */
export interface SavedBlockState {
  blockId: string
  kind: SessionEventKind
  payload: unknown
}

export function isSessionEventKind(value: unknown): value is SessionEventKind {
  return SESSION_EVENT_KINDS.some((kind) => kind === value)
}

/**
 * Whether an event takes the place of the one before it when both are the
 * same block's. Typing into a form reports every change, and a template
 * writes its files again on each, so the history keeps the form and its files
 * as the user left them, not each keystroke.
 */
export function replacesPreviousEvent(kind: SessionEventKind): boolean {
  return kind === "inputs" || kind === "render"
}

/**
 * Check an event a block reported, and serialize its payload.
 *
 * Fails with a SessionEventError when the block id or kind is not one, or the
 * payload is not JSON or is longer than SESSION_EVENT_PAYLOAD_MAX_LENGTH.
 */
export function parseSessionEvent(
  request: SessionEventRequest,
): Effect.Effect<SessionEvent, SessionEventError> {
  const { blockId, kind } = request
  if (typeof blockId !== "string" || blockId === "") {
    return refuse("a session event needs the id of its block")
  }
  if (blockId.length > SESSION_EVENT_BLOCK_ID_MAX_LENGTH) {
    return refuse(
      `a session event's block id can be at most ${SESSION_EVENT_BLOCK_ID_MAX_LENGTH} characters`,
    )
  }
  if (!isSessionEventKind(kind)) {
    return refuse(`a session event's kind must be one of ${SESSION_EVENT_KINDS.join(", ")}`)
  }

  let payload: string | undefined
  try {
    // undefined for a payload JSON has no form for, such as a function
    payload = JSON.stringify(request.payload)
  } catch {
    payload = undefined
  }
  if (payload === undefined) {
    return refuse(`the ${kind} event of block "${blockId}" has a payload that is not JSON`)
  }
  if (payload.length > SESSION_EVENT_PAYLOAD_MAX_LENGTH) {
    return refuse(
      `the ${kind} event of block "${blockId}" is ${payload.length} characters of JSON, more than the ${SESSION_EVENT_PAYLOAD_MAX_LENGTH} a session event can be`,
    )
  }
  return Effect.succeed({ blockId, kind, payload })
}

function refuse(message: string): Effect.Effect<never, SessionEventError> {
  return Effect.fail(new SessionEventError({ message }))
}
