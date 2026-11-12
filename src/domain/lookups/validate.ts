/**
 * Merges what a file and its includes declare, and checks how the
 * declarations refer to each other: every template names something that
 * exists, a URL's host comes only from literal text and the auth block, no
 * lookup chains into itself, and every use passes exactly the params it takes.
 * Runbooks refuses a module or form with any of these problems when it loads,
 * and `runbooks-cli validate` reports them without the app.
 */
import type { FileDeclarations } from "./parse.ts"
import { tokens, type Ref, type Token } from "./template.ts"
import {
  AUTH_FACTS,
  type AuthKind,
  type CheckDef,
  type Definitions,
  type Group,
  type LookupDef,
  type Problem,
  type RequestTemplate,
  type Use,
} from "./types.ts"

/**
 * Merge a file's declarations with its includes'. An include only makes
 * definitions available: its own preflight is a problem, and so is a lookup or
 * check defined twice.
 */
export function mergeDeclarations(
  own: FileDeclarations,
  includes: readonly FileDeclarations[],
): { definitions: Definitions; preflight: readonly Use[]; problems: Problem[] } {
  const problems: Problem[] = [...own.problems]
  const groups: Record<string, Group> = {}
  const lookups: Record<string, LookupDef> = {}
  const checks: Record<string, CheckDef> = {}

  for (const file of [own, ...includes]) {
    if (file !== own) {
      problems.push(...file.problems)
      if (file.preflight.length > 0) {
        problems.push({
          source: file.lookups[0]?.source ?? file.checks[0]?.source ?? "an include",
          message:
            "An included file only defines lookups and checks; preflight belongs to the module or form.",
        })
      }
    }
    for (const group of file.groups) {
      const known = groups[group.name]
      if (known && known.auth !== group.auth) {
        problems.push({
          source: sourceOf(file),
          message: `Group ${group.name} needs ${known.auth} in one file and ${group.auth} in another. A group has one kind of auth block.`,
        })
        continue
      }
      groups[group.name] = known
        ? { ...known, scopes: [...new Set([...known.scopes, ...group.scopes])] }
        : group
    }
    for (const [defs, table, kind] of [
      [file.lookups, lookups, "Lookup"],
      [file.checks, checks, "Check"],
    ] as const) {
      for (const def of defs) {
        const known = table[def.id]
        if (known) {
          problems.push({
            source: def.source,
            message: `${kind} ${def.id} is defined twice: here and in ${known.source}.`,
          })
          continue
        }
        ;(table as Record<string, typeof def>)[def.id] = def
      }
    }
  }
  return { definitions: { groups, lookups, checks }, preflight: own.preflight, problems }
}

const sourceOf = (file: FileDeclarations): string =>
  file.lookups[0]?.source ?? file.checks[0]?.source ?? file.problems[0]?.source ?? "a file"

/** Where the definitions are used, so uses can be checked too. */
export interface Uses {
  /** Each use of a lookup, by where it is, such as `variables.owners.lookup`. */
  readonly lookups: readonly { readonly where: string; readonly use: Use }[]
  readonly preflight: readonly Use[]
  /** The form's input names, when known, so `.inputs.<name>` can be checked. */
  readonly inputs?: readonly string[] | undefined
  /** The file the uses are in. */
  readonly source: string
}

/** Every problem with how the definitions and their uses refer to each other. */
export function checkDefinitions(definitions: Definitions, uses: Uses): Problem[] {
  const problems: Problem[] = []
  for (const lookup of Object.values(definitions.lookups)) {
    checkRequest(lookup, "lookup", definitions, uses.inputs, problems)
  }
  for (const check of Object.values(definitions.checks)) {
    checkRequest(check, "check", definitions, uses.inputs, problems)
    for (const [key, text] of [
      ["message", check.message],
      ["fix", check.fix],
    ] as const) {
      if (text === undefined) continue
      checkTemplate(
        text,
        `Check ${check.id}: ${key}`,
        check,
        "text",
        definitions,
        uses.inputs,
        problems,
      )
    }
  }
  problems.push(...cycleProblems(definitions))

  for (const { where, use } of uses.lookups) {
    const lookup = definitions.lookups[use.from]
    if (!lookup) {
      problems.push({
        source: uses.source,
        message: `${where} uses ${use.from}, which isn't defined or included.${known(definitions.lookups)}`,
      })
      continue
    }
    if (lookup.fields.value === undefined) {
      problems.push({
        source: uses.source,
        message: `${where} uses ${use.from}, which declares no value field, so its rows have nothing to fill the input with. Add value to its fields.`,
      })
    }
    checkUse(use, lookup.params, where, uses, problems)
  }
  uses.preflight.forEach((use, i) => {
    const where = `preflight[${i}]`
    const check = definitions.checks[use.from]
    if (!check) {
      problems.push({
        source: uses.source,
        message: `${where} runs ${use.from}, which isn't defined or included.${known(definitions.checks)}`,
      })
      return
    }
    checkUse(use, check.params, where, uses, problems)
  })
  return problems
}

const known = (table: Readonly<Record<string, unknown>>): string => {
  const names = Object.keys(table).sort()
  return names.length > 0 ? ` Defined: ${names.join(", ")}.` : ""
}

function checkUse(
  use: Use,
  params: readonly string[],
  where: string,
  uses: Uses,
  problems: Problem[],
) {
  const given = Object.keys(use.with)
  const missing = params.filter((param) => !given.includes(param))
  const unknown = given.filter((param) => !params.includes(param))
  if (missing.length > 0) {
    problems.push({
      source: uses.source,
      message: `${where} doesn't pass ${missing.join(", ")}, which ${use.from} takes.`,
    })
  }
  if (unknown.length > 0) {
    problems.push({
      source: uses.source,
      message: `${where} passes ${unknown.join(", ")}, which ${use.from} doesn't take.${params.length > 0 ? ` It takes ${params.join(", ")}.` : ""}`,
    })
  }
  for (const [param, value] of Object.entries(use.with)) {
    let found: Token[]
    try {
      found = tokens(value)
    } catch (err) {
      problems.push({
        source: uses.source,
        message: `${where}.with.${param}: ${(err as Error).message}`,
      })
      continue
    }
    for (const { ref } of found) {
      if (ref.kind !== "inputs") {
        problems.push({
          source: uses.source,
          message: `${where}.with.${param} can read only the form's values, as .inputs.<name>.`,
        })
      } else if (uses.inputs && !uses.inputs.includes(ref.name)) {
        problems.push({
          source: uses.source,
          message: `${where}.with.${param} reads .inputs.${ref.name}, which the form doesn't have.`,
        })
      }
    }
  }
}

/** Where in a request a template is: each place encodes and allows different values. */
type Place = "host" | "url" | "header" | "body" | "graphql" | "text"

function checkRequest(
  def: LookupDef | CheckDef,
  kind: "lookup" | "check",
  definitions: Definitions,
  inputs: readonly string[] | undefined,
  problems: Problem[],
) {
  const label = `${kind === "lookup" ? "Lookup" : "Check"} ${def.id}`
  const { request } = def
  const schemeAndHost = urlHostPart(request.url)
  checkTemplate(schemeAndHost, `${label}: url`, def, "host", definitions, inputs, problems)
  checkTemplate(
    request.url.slice(schemeAndHost.length),
    `${label}: url`,
    def,
    "url",
    definitions,
    inputs,
    problems,
  )
  for (const [name, value] of Object.entries(request.headers)) {
    checkTemplate(value, `${label}: headers.${name}`, def, "header", definitions, inputs, problems)
  }
  walkStrings(request.body, "body", (text, at) => {
    const place: Place = isGraphqlQuery(request, at) ? "graphql" : "body"
    checkTemplate(text, `${label}: ${at}`, def, place, definitions, inputs, problems)
  })
}

/** The URL's scheme and host, which may hold only literal text and `.auth`. */
export function urlHostPart(url: string): string {
  const scheme = url.indexOf("://")
  if (scheme < 0) return ""
  const path = url.slice(scheme + 3).search(/[/?#]/)
  return path < 0 ? url : url.slice(0, scheme + 3 + path)
}

/** Whether `at` is a GraphQL document: the `query` string of a JSON body that has one. */
export function isGraphqlQuery(request: RequestTemplate, at: string): boolean {
  return at === "body.query" && typeof (request.body as { query?: unknown })?.query === "string"
}

export function walkStrings(value: unknown, at: string, visit: (text: string, at: string) => void) {
  if (typeof value === "string") visit(value, at)
  else if (Array.isArray(value)) value.forEach((item, i) => walkStrings(item, `${at}[${i}]`, visit))
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) walkStrings(item, `${at}.${key}`, visit)
  }
}

function checkTemplate(
  text: string,
  where: string,
  def: LookupDef | CheckDef,
  place: Place,
  definitions: Definitions,
  inputs: readonly string[] | undefined,
  problems: Problem[],
) {
  const problem = (message: string): void => {
    problems.push({ source: def.source, message: `${where}: ${message}` })
  }
  let found: Token[]
  try {
    found = tokens(text)
  } catch (err) {
    return problem((err as Error).message)
  }
  if (found.length > 0 && place === "graphql") {
    return problem(
      "a GraphQL query can't hold templates, since typed text could change the query. Pass values in the body's variables and read them as $names in the query.",
    )
  }
  const group = definitions.groups[def.group]
  const isLookup = def.id in definitions.lookups && definitions.lookups[def.id] === def
  for (const { ref } of found) {
    if (place === "host" && ref.kind !== "auth") {
      problem(
        "a URL's scheme and host can use only literal text and .auth, so a request can't be sent somewhere a form value picks.",
      )
      continue
    }
    if (place === "text" && (ref.kind === "lookups" || ref.kind === "query")) {
      problem(`a check's ${where.split(": ").pop()} can read .params, .auth and .inputs only.`)
      continue
    }
    problems.push(
      ...refProblems(ref, def, isLookup, group?.auth, definitions, inputs).map((message) => ({
        source: def.source,
        message: `${where}: ${message}`,
      })),
    )
  }
}

function refProblems(
  ref: Ref,
  def: LookupDef | CheckDef,
  isLookup: boolean,
  auth: AuthKind | undefined,
  definitions: Definitions,
  inputs: readonly string[] | undefined,
): string[] {
  switch (ref.kind) {
    case "params":
      return def.params.includes(ref.name)
        ? []
        : [
            `.params.${ref.name} isn't one of its params${def.params.length > 0 ? ` (${def.params.join(", ")})` : ""}. Declare it under params.`,
          ]
    case "auth": {
      const facts = auth ? AUTH_FACTS[auth] : []
      return facts.includes(ref.name)
        ? []
        : [
            `.auth.${ref.name} isn't something ${auth ?? "its auth block"} knows. It knows ${facts.join(", ")}.`,
          ]
    }
    case "inputs":
      return inputs && !inputs.includes(ref.name)
        ? [`.inputs.${ref.name} isn't one of the form's inputs.`]
        : []
    case "query":
      return isLookup ? [] : [".query is the text typed in a field, so only a lookup can read it."]
    case "lookups": {
      const other = definitions.lookups[ref.lookup]
      if (!other)
        return [
          `.lookups.${ref.lookup} isn't a defined or included lookup.${known(definitions.lookups)}`,
        ]
      if (!(ref.field in other.fields)) {
        return [
          `${ref.lookup} has no field ${ref.field}. Its fields are ${Object.keys(other.fields).join(", ")}.`,
        ]
      }
      if (other.params.length > 0) {
        return [`${ref.lookup} takes params, so another lookup can't chain from it.`]
      }
      return []
    }
  }
}

/** The lookups each lookup's request reads from. */
export function chainedLookups(def: LookupDef | CheckDef): string[] {
  const found = new Set<string>()
  const visit = (text: string) => {
    try {
      for (const { ref } of tokens(text)) if (ref.kind === "lookups") found.add(ref.lookup)
    } catch {
      // A malformed template is reported by checkTemplate.
    }
  }
  visit(def.request.url)
  Object.values(def.request.headers).forEach(visit)
  walkStrings(def.request.body, "body", visit)
  return [...found]
}

function cycleProblems(definitions: Definitions): Problem[] {
  const problems: Problem[] = []
  const state = new Map<string, "visiting" | "done">()
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === "done") return
    if (state.get(id) === "visiting") {
      const cycle = [...path.slice(path.indexOf(id)), id]
      problems.push({
        source: definitions.lookups[id]?.source ?? "",
        message: `Lookups chain in a circle: ${cycle.join(" -> ")}.`,
      })
      return
    }
    const def = definitions.lookups[id]
    if (!def) return
    state.set(id, "visiting")
    for (const next of chainedLookups(def)) visit(next, [...path, id])
    state.set(id, "done")
  }
  for (const id of Object.keys(definitions.lookups)) visit(id, [])
  return problems
}

/**
 * The groups a form's uses need bound to an auth block: each used lookup's
 * and check's group, and the groups of the lookups they chain from.
 */
export function usedGroups(
  definitions: Definitions,
  uses: readonly Use[],
  preflight: readonly Use[],
): string[] {
  const groups = new Set<string>()
  const seen = new Set<string>()
  const visit = (def: LookupDef | CheckDef | undefined) => {
    if (!def || seen.has(def.id)) return
    seen.add(def.id)
    groups.add(def.group)
    for (const id of chainedLookups(def)) visit(definitions.lookups[id])
  }
  for (const use of uses) visit(definitions.lookups[use.from])
  for (const use of preflight) visit(definitions.checks[use.from])
  return [...groups].sort()
}

/** One auth block in the runbook, as a form's binding names it. */
export interface BoundBlock {
  readonly id: string
  readonly kind: string
  /** The OAuth scopes it requests, for kinds that have scopes. */
  readonly scopes?: readonly string[] | undefined
}

/**
 * Problems with how a form binds the groups it uses to the runbook's auth
 * blocks: a group not bound, bound to a block that doesn't exist or is the
 * wrong kind, or bound to one that doesn't request the scopes it needs.
 */
export function bindingProblems(
  definitions: Definitions,
  groups: readonly string[],
  binding: Readonly<Record<string, string>>,
  blocks: readonly BoundBlock[],
): string[] {
  const problems: string[] = []
  for (const name of groups) {
    const group = definitions.groups[name]
    if (!group) continue
    const blockId = binding[name]
    if (!blockId) {
      problems.push(
        `The form's lookups need the ${name} group bound to a ${group.auth} block. Add it to the auth prop, such as auth={{ ${name}: "<block id>" }}.`,
      )
      continue
    }
    const block = blocks.find((candidate) => candidate.id === blockId)
    if (!block) {
      problems.push(
        `The auth prop binds ${name} to "${blockId}", but the runbook has no block with that id.`,
      )
    } else if (block.kind !== group.auth) {
      problems.push(
        `The auth prop binds ${name} to "${blockId}", a ${block.kind} block, but ${name} needs a ${group.auth} block.`,
      )
    } else if (block.scopes) {
      const missing = group.scopes.filter((scope) => !block.scopes?.includes(scope))
      if (missing.length > 0) {
        problems.push(
          `The ${group.auth} block "${blockId}" doesn't request ${missing.join(", ")}, which ${name} needs. Add them to its scopes.`,
        )
      }
    }
  }
  for (const name of Object.keys(binding)) {
    if (!groups.includes(name)) {
      problems.push(
        `The auth prop binds ${name}, but no lookup or check the form uses is in a group by that name.`,
      )
    }
  }
  return problems
}
