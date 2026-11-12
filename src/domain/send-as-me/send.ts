/**
 * Send a request as the user an auth block signed in as, for another block
 * such as a lookup or a check. Each auth block first checks that the request
 * reads, from its provider's API.
 */
import { Effect } from "effect"
import { AwsClient, type AwsCredentials } from "../../services/AwsClient.ts"
import { GoogleClient, type GoogleCredentialRef } from "../../services/GoogleClient.ts"
import type { HttpRequest } from "../../services/HttpRequest.ts"
import { RequestRefusedError } from "../../errors/index.ts"
import { awsSendable } from "./aws.ts"
import { googleSendable } from "./google.ts"
import { isRefused } from "./shape.ts"

/** Send `request` as the AwsAuth block whose credentials are `creds`. */
export const sendAsAws = (
  creds: Pick<AwsCredentials, "accessKeyId" | "secretAccessKey" | "sessionToken">,
  request: HttpRequest,
) =>
  Effect.gen(function* () {
    const sendable = awsSendable(request)
    if (isRefused(sendable)) return yield* new RequestRefusedError({ message: sendable.refused })
    const aws = yield* AwsClient
    return yield* aws.sendSigned(creds, sendable.signing, sendable.request)
  })

/** Send `request` as the GoogleAuth block whose credential is `creds`, billed to `quotaProjectId`. */
export const sendAsGoogle = (
  creds: GoogleCredentialRef,
  request: HttpRequest,
  quotaProjectId?: string,
) =>
  Effect.gen(function* () {
    const sendable = googleSendable(request)
    if (isRefused(sendable)) return yield* new RequestRefusedError({ message: sendable.refused })
    const google = yield* GoogleClient
    return yield* google.sendAuthorized(creds, sendable, quotaProjectId)
  })
