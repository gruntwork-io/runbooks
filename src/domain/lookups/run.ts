/**
 * Runs lookups and checks. The engine builds each request from its
 * declaration, hands it to the auth block bound to its group through `send`,
 * and reads the answer. It knows no API: everything about one is in the
 * declaration, and everything about credentials is in the auth block.
 */
import type { HttpReply, HttpRequest } from "../../services/HttpRequest.ts"
import { buildRequest } from "./request.ts"
import { isMissing, readPath, rowsOf } from "./response.ts"
import { render, tokens, valueText, type TemplateValues } from "./template.ts"
import type { AuthKind, CheckDef, Definitions, LookupDef, Row, Use } from "./types.ts"
import { chainedLookups, walkStrings } from "./validate.ts"

/** Send a request as the auth block bound to `group`, which is of kind `auth`. */
export type Send = (request: HttpRequest, group: string, auth: AuthKind) => Promise<HttpReply>

export interface RunContext {
  readonly definitions: Definitions
  /** The form's values. */
  readonly inputs: Readonly<Record<string, unknown>>
  /** What the auth block bound to each group knows, read as `.auth`. */
  readonly auth: (group: string) => Readonly<Record<string, string>>
  readonly send: Send
}

export interface LookupResult {
  readonly rows: readonly Row[]
  /** Paging stopped at maxPages with more pages left. */
  readonly capped: boolean
}

/** A failure the engine explains: a bad answer, or a chain that didn't give one row. */
export class LookupFailure extends Error {}

/** Whether a lookup's request reads `.query`, so it runs again as the user types. */
export function readsQuery(def: LookupDef): boolean {
  let found = false
  const visit = (text: string) => {
    if (tokens(text).some(({ ref }) => ref.kind === "query")) found = true
  }
  visit(def.request.url)
  Object.values(def.request.headers).forEach(visit)
  walkStrings(def.request.body, "body", visit)
  return found
}

/** Run the lookup `use` names, with `query` as the text typed in the field. */
export async function runLookup(
  context: RunContext,
  use: Use,
  query = "",
  chained: Map<string, Row> = new Map(),
): Promise<LookupResult> {
  const def = context.definitions.lookups[use.from]
  if (!def) throw new LookupFailure(`${use.from} isn't a defined or included lookup.`)
  const values = await valuesFor(context, def, use, query, chained)

  const rows: Row[] = []
  let token: string | undefined
  let lastToken: string | undefined
  for (let page = 1; ; page++) {
    const request = buildRequest(
      def.request,
      values,
      token && def.next ? { to: def.next.to, token } : undefined,
    )
    const response = await sendForJson(context, def, request)
    rows.push(...rowsOf(def, response))
    const next = def.next ? readPath(response, def.next.from) : undefined
    lastToken = token
    token = isMissing(next) ? undefined : valueText(next) || undefined
    if (!token || token === lastToken) return { rows, capped: false }
    if (page >= def.maxPages) return { rows, capped: true }
  }
}

/** What a check found. A check that couldn't tell says why, never its failure message. */
export type CheckOutcome =
  | { readonly outcome: "passed" }
  | { readonly outcome: "failed"; readonly message: string; readonly fix?: string | undefined }
  | { readonly outcome: "unknown"; readonly detail: string }

/** Run the check `use` names. It never throws: anything that stops it is an "unknown" outcome. */
export async function runCheck(context: RunContext, use: Use): Promise<CheckOutcome> {
  const def = context.definitions.checks[use.from]
  if (!def) return { outcome: "unknown", detail: `${use.from} isn't a defined or included check.` }
  let values: TemplateValues
  let response: unknown
  try {
    values = await valuesFor(context, def, use, "", new Map())
    response = await sendForJson(context, def, buildRequest(def.request, values))
  } catch (err) {
    return { outcome: "unknown", detail: (err as Error).message }
  }
  const { expect } = def
  const value = readPath(response, expect.path)
  let passed: boolean
  if ("equals" in expect) {
    if (isMissing(value)) {
      return { outcome: "unknown", detail: `The response has no ${expect.path}.` }
    }
    passed = valueText(value) === expect.equals
  } else if ("exists" in expect) {
    passed = (!isMissing(value) && value !== null) === expect.exists
  } else {
    // An API with no results often leaves the list out.
    const count = Array.isArray(value) ? value.length : 0
    if (!isMissing(value) && value !== null && !Array.isArray(value)) {
      return { outcome: "unknown", detail: `The response's ${expect.path} isn't a list.` }
    }
    passed = count >= expect.minRows
  }
  if (passed) return { outcome: "passed" }
  return {
    outcome: "failed",
    message: render(def.message, values),
    ...(def.fix ? { fix: render(def.fix, values) } : {}),
  }
}

/**
 * The first page of the answer to the lookup or check `use` names, as the
 * API sent it, for recording a sample.
 */
export async function firstResponse(
  context: RunContext,
  use: Use,
  kind: "lookup" | "check",
): Promise<unknown> {
  const def =
    kind === "lookup" ? context.definitions.lookups[use.from] : context.definitions.checks[use.from]
  if (!def) throw new LookupFailure(`${use.from} isn't a defined or included ${kind}.`)
  const values = await valuesFor(context, def, use, "", new Map())
  return sendForJson(context, def, buildRequest(def.request, values))
}

/** The values a definition's templates read: its params from the use, and each chained lookup's one row. */
async function valuesFor(
  context: RunContext,
  def: LookupDef | CheckDef,
  use: Use,
  query: string,
  chained: Map<string, Row>,
): Promise<TemplateValues> {
  const inputsOnly: TemplateValues = {
    inputs: context.inputs,
    auth: {},
    params: {},
    lookups: {},
    query: "",
  }
  const params: Record<string, string> = {}
  for (const [name, value] of Object.entries(use.with)) params[name] = render(value, inputsOnly)

  const lookups: Record<string, Row> = {}
  for (const id of chainedLookups(def)) {
    let row = chained.get(id)
    if (!row) {
      const { rows } = await runLookup(context, { from: id, with: {} }, "", chained)
      if (rows.length !== 1) {
        throw new LookupFailure(
          `${def.id} reads a value from ${id}, which must give exactly one row. It gave ${rows.length}.`,
        )
      }
      row = rows[0] as Row
      const source = context.definitions.lookups[id]
      for (const { ref } of refsTo(def, id)) {
        if (source && !(ref.field in row)) {
          throw new LookupFailure(
            `${def.id} reads ${ref.field} from ${id}, but its row has no ${source.fields[ref.field]}.`,
          )
        }
      }
      chained.set(id, row)
    }
    lookups[id] = row
  }
  return { inputs: context.inputs, auth: context.auth(def.group), params, lookups, query }
}

/** The references `def`'s request makes to the lookup `id`. */
function refsTo(def: LookupDef | CheckDef, id: string) {
  const found: { ref: { lookup: string; field: string } }[] = []
  const visit = (text: string) => {
    for (const { ref } of tokens(text)) {
      if (ref.kind === "lookups" && ref.lookup === id) found.push({ ref })
    }
  }
  visit(def.request.url)
  Object.values(def.request.headers).forEach(visit)
  walkStrings(def.request.body, "body", visit)
  return found
}

/** The longest part of an error body a message shows. */
const BODY_EXCERPT = 500

async function sendForJson(
  context: RunContext,
  def: LookupDef | CheckDef,
  request: HttpRequest,
): Promise<unknown> {
  const group = context.definitions.groups[def.group]
  if (!group) throw new LookupFailure(`${def.id} is in group ${def.group}, which isn't defined.`)
  const reply = await context.send(request, def.group, group.auth)
  if (reply.status < 200 || reply.status >= 300) {
    const body = reply.body.trim()
    throw new LookupFailure(
      `${def.id}: ${new URL(request.url).hostname} answered ${reply.status}${body ? `: ${body.slice(0, BODY_EXCERPT)}` : "."}`,
    )
  }
  try {
    return JSON.parse(reply.body) as unknown
  } catch {
    throw new LookupFailure(`${def.id}: ${new URL(request.url).hostname} didn't answer with JSON.`)
  }
}

/**
 * The form inputs a use reads, through its params, its definition's request
 * and the lookups that request chains from, so a form runs it again only when
 * one of them changes.
 */
export function inputsRead(definitions: Definitions, use: Use): string[] {
  const names = new Set<string>()
  const visit = (text: string) => {
    try {
      for (const { ref } of tokens(text)) if (ref.kind === "inputs") names.add(ref.name)
    } catch {
      // A malformed template is a load problem, reported when the file loads.
    }
  }
  Object.values(use.with).forEach(visit)
  const seen = new Set<string>()
  const visitDef = (def: LookupDef | CheckDef | undefined) => {
    if (!def || seen.has(def.id)) return
    seen.add(def.id)
    visit(def.request.url)
    Object.values(def.request.headers).forEach(visit)
    walkStrings(def.request.body, "body", visit)
    for (const id of chainedLookups(def)) visitDef(definitions.lookups[id])
  }
  visitDef(definitions.lookups[use.from] ?? definitions.checks[use.from])
  return [...names].sort()
}
