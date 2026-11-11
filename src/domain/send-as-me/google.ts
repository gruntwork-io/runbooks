/**
 * What GoogleAuth will send as the signed-in user for another block: a GET,
 * to a Google API host. The runbook's author chose the request, and is
 * trusted as they are for a Command, so these rules don't name APIs. They
 * keep the request on Google's own API hosts and to reads, so a lookup can't
 * change anything by mistake.
 */
import type { HttpRequest } from "../../services/HttpRequest.ts"
import { refuse, shapeRequest, isRefused, type Refused } from "./shape.ts"

/** A Google API host: one label under googleapis.com, such as admin.googleapis.com. */
const API_HOST = /^[a-z0-9-]+\.googleapis\.com$/

/** Whether GoogleAuth will send `request`: a GET to a Google API host. */
export function googleSendable(request: HttpRequest): HttpRequest | Refused {
  const shaped = shapeRequest(request, ["accept"])
  if (isRefused(shaped)) return shaped
  const { url } = shaped
  if (shaped.request.method !== "GET") return refuse("GoogleAuth sends only GET requests.")
  if (!API_HOST.test(url.hostname)) {
    return refuse(
      `GoogleAuth sends requests only to Google API hosts, such as admin.googleapis.com, not ${url.hostname}.`,
    )
  }
  return shaped.request
}
