/**
 * Builds the request a lookup or check sends from its declaration. Each value
 * a template reads is encoded for where it goes, on its own: URL-encoded in a
 * path or query string, a JSON string in a body, so typed text can't change a
 * URL or the shape of a body.
 */
import type { HttpRequest } from "../../services/HttpRequest.ts"
import { render, type Ref, type TemplateValues, type Token } from "./template.ts"
import type { RequestTemplate } from "./types.ts"
import { urlHostPart } from "./validate.ts"

/** Where a page token goes in the next request. */
export interface PageToken {
  readonly to: string
  readonly token: string
}

export function buildRequest(
  template: RequestTemplate,
  values: TemplateValues,
  page?: PageToken,
): HttpRequest {
  const hostPart = urlHostPart(template.url)
  const host = render(hostPart, values)
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error(`The request's host came out as "${host}", which isn't an https host.`)
  }
  const rest = template.url.slice(hostPart.length)
  const query = rest.search(/[?#]/)
  const pathEnd = query < 0 ? rest.length : query
  const url = new URL(
    host +
      render(rest, values, (value, token) => {
        if (token.start < pathEnd) checkPathValue(value, token)
        return encodeURIComponent(value)
      }),
  )

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(template.headers)) {
    const text = render(value, values)
    if (/[\r\n]/.test(text)) throw new Error(`The ${name} header came out with a line break.`)
    headers[name.toLowerCase()] = text
  }

  let body = renderBody(template.body, values)
  if (page) {
    const [where, ...path] = page.to.split(".")
    if (where === "query") url.searchParams.set(path.join("."), page.token)
    else body = setPath(body ?? {}, path, page.token)
  }

  const request: HttpRequest = { method: template.method, url: url.toString(), headers }
  if (template.method === "GET" || body === undefined) return request
  const form = (headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")
  return { ...request, body: form ? formBody(body) : JSON.stringify(body) }
}

/** What a template reads, as a sentence names it. */
function describeRef(ref: Ref): string {
  switch (ref.kind) {
    case "inputs":
      return `the ${ref.name} input`
    case "auth":
      return `the auth block's ${ref.name}`
    case "params":
      return `the ${ref.name} param`
    case "lookups":
      return `${ref.lookup}'s ${ref.field}`
    case "query":
      return "what's typed"
  }
}

/**
 * A value in the URL's path must be a whole segment of its own: an empty one
 * would collapse the path, and `.` or `..` would move it up, even encoded.
 */
function checkPathValue(value: string, token: Token) {
  if (value === "") {
    throw new Error(`The request's path needs ${describeRef(token.ref)}, which has no value yet.`)
  }
  if (value === "." || value === "..") {
    const what = describeRef(token.ref)
    throw new Error(
      `${what.charAt(0).toUpperCase()}${what.slice(1)} is "${value}", which a request's path can't hold.`,
    )
  }
}

/** The body with every string in it rendered. The strings stay strings, whatever they read. */
function renderBody(body: unknown, values: TemplateValues): unknown {
  if (typeof body === "string") return render(body, values)
  if (Array.isArray(body)) return body.map((item) => renderBody(item, values))
  if (typeof body === "object" && body !== null) {
    return Object.fromEntries(
      Object.entries(body).map(([key, item]) => [key, renderBody(item, values)]),
    )
  }
  return body
}

function setPath(body: unknown, path: readonly string[], token: string): unknown {
  const root = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>
  let node = root
  path.slice(0, -1).forEach((key) => {
    const child = node[key]
    node[key] = typeof child === "object" && child !== null ? child : {}
    node = node[key] as Record<string, unknown>
  })
  const lastKey = path.at(-1)
  if (lastKey !== undefined) node[lastKey] = token
  return root
}

function formBody(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("A form body must map names to values.")
  }
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(body)) {
    if (typeof value === "object" && value !== null) {
      throw new Error(`The form field ${name} must be a single value.`)
    }
    params.set(name, String(value))
  }
  return params.toString()
}
