/**
 * What GoogleAuth will send as the signed-in user: GET requests, to the
 * Google API hosts listed here. A host joins when a lookup first needs it.
 * Cloud Storage never joins, because its paths name buckets, and anyone can
 * own a bucket and read the requests made to it.
 */
import type { HttpRequest } from "../../services/HttpRequest.ts"
import { refuse, shapeRequest, isRefused, type Refused } from "./shape.ts"

const HOSTS = [
  "admin.googleapis.com",
  "cloudidentity.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "groupssettings.googleapis.com",
  "serviceusage.googleapis.com",
]

/**
 * Paths that return a secret even though they're reads: a user's backup
 * verification codes. Refusing them is best effort: no list can name every
 * read that returns a secret.
 */
const SECRET_READS: readonly { host: string; segment: string }[] = [
  { host: "admin.googleapis.com", segment: "verificationCodes" },
]

/**
 * Whether GoogleAuth will send `request`. It sends GET requests only, to a
 * listed host, except the known secret reads.
 */
export function googleSendable(request: HttpRequest): HttpRequest | Refused {
  const shaped = shapeRequest(request, ["accept"])
  if (isRefused(shaped)) return shaped
  const { url } = shaped
  if (shaped.request.method !== "GET") return refuse("GoogleAuth sends only GET requests.")
  if (!HOSTS.includes(url.hostname)) {
    return refuse(
      `GoogleAuth doesn't send requests to ${url.hostname}. It sends them only to ${HOSTS.join(", ")}.`,
    )
  }
  const segments = url.pathname.split("/")
  const secret = SECRET_READS.find(
    (read) => read.host === url.hostname && segments.includes(read.segment),
  )
  if (secret)
    return refuse(`GoogleAuth doesn't send requests for ${secret.segment}: they return a secret.`)
  return shaped.request
}
