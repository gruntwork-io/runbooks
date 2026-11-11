/**
 * Builds the request a lookup or check sends from its declaration. Each value
 * a template reads is encoded for where it goes, on its own: URL-encoded in a
 * path or query string, a JSON string in a body, so typed text can't change a
 * URL or the shape of a body.
 */
import type { HttpRequest } from "../../services/HttpRequest.ts"
import { render, type TemplateValues } from "./template.ts"
import type { RequestTemplate } from "./types.ts"
import { urlHostPart, walkStrings } from "./validate.ts"

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
  const url = new URL(
    host + render(template.url.slice(hostPart.length), values, encodeURIComponent),
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

/** The body with every string in it rendered. The strings stay strings, whatever they read. */
function renderBody(body: unknown, values: TemplateValues): unknown {
  if (body === undefined) return undefined
  const rendered = structuredClone(body) as unknown
  const replacements: { at: string; text: string }[] = []
  walkStrings(rendered, "", (text, at) => replacements.push({ at, text: render(text, values) }))
  if (typeof rendered === "string") return replacements[0]?.text ?? rendered
  for (const { at, text } of replacements) assign(rendered, at, text)
  return rendered
}

/** Set the string at `at`, a path such as `.a.b[0]`, inside `root`. */
function assign(root: unknown, at: string, text: string) {
  const steps = [...at.matchAll(/\.([^.[\]]+)|\[(\d+)\]/g)].map((m) => m[1] ?? Number(m[2]))
  let node = root as Record<string | number, unknown>
  steps.slice(0, -1).forEach((step) => {
    node = node[step] as Record<string | number, unknown>
  })
  const lastStep = steps.at(-1)
  if (lastStep !== undefined) node[lastStep] = text
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
