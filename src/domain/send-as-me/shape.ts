/**
 * The rules every auth block applies before it sends a request as the
 * signed-in user, whatever the service: an HTTPS URL to a bare host, and only
 * the headers the block allows. Each block then checks the host and the
 * operation against its own list, so a request can only read, and only from
 * a host the provider runs.
 */
import type { HttpRequest } from "../../services/HttpRequest.ts"

/** A request the block refuses to send, and why, in words for the runbook's author. */
export interface Refused {
  readonly refused: string
}

export const refuse = (reason: string): Refused => ({ refused: reason })

export const isRefused = (value: object): value is Refused => "refused" in value

/** A request whose URL and headers passed the shared rules. */
export interface ShapedRequest {
  readonly request: HttpRequest
  readonly url: URL
}

/**
 * Check `request`'s URL and headers, and lowercase its header names.
 * `allowedHeaders` are the lowercase names the caller may set; the auth block
 * sets every other header itself, Host and Authorization among them.
 */
export function shapeRequest(
  request: HttpRequest,
  allowedHeaders: readonly string[],
): ShapedRequest | Refused {
  if (request.method !== "GET" && request.method !== "POST") {
    return refuse(`Only GET and POST requests can be sent, not ${String(request.method)}.`)
  }
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return refuse(`${request.url} isn't a URL.`)
  }
  if (url.protocol !== "https:") return refuse(`${request.url} isn't an https URL.`)
  if (url.username || url.password) return refuse(`${request.url} names a user in its host.`)
  if (url.port) return refuse(`${request.url} names a port. Requests go to the default one.`)
  if (url.hash) return refuse(`${request.url} has a fragment, which a server never sees.`)

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase()
    if (!allowedHeaders.includes(lower)) {
      return refuse(
        `A request can't set the ${name} header. It can set: ${allowedHeaders.join(", ")}.`,
      )
    }
    if (lower in headers) return refuse(`The ${name} header is set twice.`)
    headers[lower] = value
  }
  if (request.method === "GET" && request.body) {
    return refuse("A GET request can't have a body.")
  }
  return { request: { ...request, headers }, url }
}
