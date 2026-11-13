/**
 * The rules for an Admonition with an id, whose confirmation is an output
 * later blocks can wait on. The app and `runbooks test` both apply them, so a
 * runbook the app refuses fails its tests too.
 */

/** The output a confirmed Admonition with an id sets. */
export const CONFIRMED_OUTPUT = "CONFIRMED"

/** Why a gated Admonition's confirmation matters, for its error messages. */
export const GATE_PURPOSE =
  "An Admonition with an id sets its CONFIRMED output when its confirmation button is clicked, so later blocks can wait on it."

export interface GateProps {
  readonly id: string
  readonly confirmationText?: unknown
  readonly closable?: unknown
  readonly allowPermanentHide?: unknown
}

/**
 * What's wrong with a gated Admonition's props, as the end of a sentence that
 * starts with the block, or null when nothing is.
 */
export function gateProblem({
  id,
  confirmationText,
  closable,
  allowPermanentHide,
}: GateProps): string | null {
  if (!id) return "needs a non-empty id."
  if (typeof confirmationText !== "string" || !confirmationText) {
    return "needs confirmationText, the label of the button that confirms it."
  }
  if (closable === true) return "can't be closable: closed, it could never be confirmed."
  if (allowPermanentHide === true) {
    return "can't use allowPermanentHide: hidden, it could never be confirmed."
  }
  return null
}
