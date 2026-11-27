/**
 * What the window says of a failure that is not one of the engine's typed
 * errors: a defect's message, or the reason the engine client gives.
 */
import { Cause } from "effect"
import type { RpcClientError } from "effect/rpc"

/** The message of the defect in `cause`. */
export const defectText = (cause: Cause.Cause<unknown>): string => {
  const defect = Cause.squash(cause)
  return defect instanceof Error ? defect.message : String(defect)
}

/** Why the engine client couldn't reach the engine, without the reason's class name. */
export const clientErrorText = (error: RpcClientError.RpcClientError): string =>
  error.reason.message
