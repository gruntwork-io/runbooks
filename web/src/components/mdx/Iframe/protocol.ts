/**
 * The postMessage protocol between an Iframe block and a page it embeds from
 * the runbook's assets folder. The page posts to `parent` and listens for
 * messages as it would in an iframe; in its `<webview>` guest, the preload
 * relays both directions (electron/shared/embed-messaging.ts).
 *
 * Page to runbook:
 *   { type: "runbooks:set-outputs", outputs: { region: "us-east-1" } }
 *   { type: "runbooks:get-inputs" }
 * Runbook to page:
 *   { type: "runbooks:inputs", inputs: { ... } }
 */
import { MESSAGE_TYPE_PREFIX } from "../../../../../electron/shared/embed-messaging.ts"

const GET_INPUTS_MESSAGE = "runbooks:get-inputs"
const SET_OUTPUTS_MESSAGE = "runbooks:set-outputs"

/** Longest output value a page may set, in UTF-16 code units. */
export const MAX_OUTPUT_LENGTH = 64 * 1024

/** A valid output name: the rule Command outputs follow (IDENT_RE in src/domain/exec/script.ts). */
export const OUTPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type PageMessage =
  | { kind: "get-inputs" }
  | { kind: "set-outputs"; outputs: Record<string, string> }
  | { kind: "invalid"; error: string }

/**
 * Parse the data of a message a page posted. Returns null when `data` is not
 * a Runbooks message (its `type` doesn't start with "runbooks:"), so a page
 * can use postMessage for its own purposes.
 */
export function parsePageMessage(
  data: unknown,
  declaredOutputs: ReadonlySet<string>,
): PageMessage | null {
  if (
    !isRecord(data) ||
    typeof data.type !== "string" ||
    !data.type.startsWith(MESSAGE_TYPE_PREFIX)
  ) {
    return null
  }
  switch (data.type) {
    case GET_INPUTS_MESSAGE:
      return { kind: "get-inputs" }
    case SET_OUTPUTS_MESSAGE:
      return parseOutputs(data.outputs, declaredOutputs)
    default:
      return { kind: "invalid", error: `The page sent an unknown message type, "${data.type}".` }
  }
}

function parseOutputs(outputs: unknown, declaredOutputs: ReadonlySet<string>): PageMessage {
  if (!isRecord(outputs)) {
    return { kind: "invalid", error: "The page sent `outputs` that isn't an object of strings." }
  }
  const entries = Object.entries(outputs)
  for (const [name, value] of entries) {
    if (!declaredOutputs.has(name)) {
      return {
        kind: "invalid",
        error: `The page set output "${name}", which the block's outputs prop doesn't list.`,
      }
    }
    if (typeof value !== "string") {
      return {
        kind: "invalid",
        error: `The page set output "${name}" to a ${typeof value}. Outputs must be strings.`,
      }
    }
    if (value.length > MAX_OUTPUT_LENGTH) {
      return {
        kind: "invalid",
        error: `The page set output "${name}" to more than ${MAX_OUTPUT_LENGTH} characters.`,
      }
    }
  }
  // fromEntries defines each name as an own property, so even a declared
  // "__proto__" can't replace the result's prototype.
  return { kind: "set-outputs", outputs: Object.fromEntries(entries) as Record<string, string> }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
