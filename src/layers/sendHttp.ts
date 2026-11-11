/**
 * The one way an auth block's layer sends a request for another block, once
 * it has added its credentials: no redirects, since a redirect could lead to a
 * host the block doesn't send to, a timeout, and a cap on the answer's size.
 */
import type { HttpReply, HttpRequest } from "../services/HttpRequest.ts"

const TIMEOUT_MS = 30_000

/** The largest answer read. A lookup that needs more pages through it. */
export const MAX_REPLY_BYTES = 5 * 1024 * 1024

/** Send `request` with `headers`, which replace its own, and read the answer whatever its status. */
export async function sendHttp(
  request: HttpRequest,
  headers: Readonly<Record<string, string>>,
): Promise<HttpReply> {
  const response = await fetch(request.url, {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: await readCapped(response, new URL(request.url).hostname),
  }
}

async function readCapped(response: Response, host: string): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_REPLY_BYTES) {
    await response.body?.cancel()
    throw new Error(tooLarge(host))
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_REPLY_BYTES) {
      await reader.cancel()
      throw new Error(tooLarge(host))
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf-8")
}

const tooLarge = (host: string) =>
  `The answer from ${host} is larger than ${MAX_REPLY_BYTES / 1024 / 1024} MB. Ask for fewer rows per page.`
