/**
 * Reads lookup and check declarations from a parsed YAML document: a module's
 * runbook_block.yml, or a form's boilerplate.yml, whose keys carry an `x-`
 * prefix. This checks each declaration's shape; validate.ts checks how they
 * refer to each other once a file and its includes are merged.
 */
import {
  AUTH_KINDS,
  type AuthKind,
  type CheckDef,
  type Expectation,
  type Group,
  type InputLookups,
  type LookupDef,
  type Paging,
  type Problem,
  type RequestTemplate,
  type ShortcutUse,
  type Use,
} from "./types.ts"

/** The paging cap when a lookup sets none, and the most it can set. */
export const DEFAULT_MAX_PAGES = 10
export const MAX_PAGES_LIMIT = 50

/** `""` for runbook_block.yml, `"x-"` for boilerplate.yml. */
export type KeyPrefix = "" | "x-"

/** What one file declares. */
export interface FileDeclarations {
  readonly include: readonly string[]
  readonly groups: readonly Group[]
  readonly lookups: readonly LookupDef[]
  readonly checks: readonly CheckDef[]
  readonly preflight: readonly Use[]
  readonly problems: readonly Problem[]
}

type Obj = Record<string, unknown>

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Keys a group holds besides its lookups or checks. */
const GROUP_KEYS = new Set(["auth", "scopes"])

const NAME = /^[A-Za-z_][\w-]*$/

/** Read the lookup and check declarations from `doc`, which came from the file `source`. */
export function parseDeclarations(
  doc: unknown,
  source: string,
  prefix: KeyPrefix = "",
): FileDeclarations {
  const problems: Problem[] = []
  const problem = (message: string): void => {
    problems.push({ source, message })
  }
  const groups = new Map<string, Group>()
  const lookups: LookupDef[] = []
  const checks: CheckDef[] = []
  const root = isObj(doc) ? doc : {}

  const include = stringList(root[`${prefix}include`], `${prefix}include`, problem)

  const readGroups = (key: string, read: (group: Group, name: string, raw: unknown) => void) => {
    const raw = root[key]
    if (raw === undefined) return
    if (!isObj(raw)) return problem(`${key} must map group names to groups.`)
    for (const [groupName, rawGroup] of Object.entries(raw)) {
      const group = parseGroup(groupName, rawGroup, `${key}.${groupName}`, problem)
      if (!group) continue
      const known = groups.get(groupName)
      if (known && known.auth !== group.auth) {
        problem(
          `Group ${groupName} needs ${known.auth} in one place and ${group.auth} in another. A group has one kind of auth block.`,
        )
        continue
      }
      groups.set(groupName, known ? mergeScopes(known, group) : group)
      for (const [name, entry] of Object.entries(rawGroup as Obj)) {
        if (GROUP_KEYS.has(name)) continue
        if (!NAME.test(name)) {
          problem(`${key}.${groupName}.${name}: a name is letters, digits, _ and -.`)
          continue
        }
        read(group, name, entry)
      }
    }
  }

  readGroups(`${prefix}lookups`, (group, name, raw) => {
    const lookup = parseLookup(group, name, raw, source, problem)
    if (lookup) lookups.push(lookup)
  })
  readGroups(`${prefix}checks`, (group, name, raw) => {
    const check = parseCheck(group, name, raw, source, problem)
    if (check) checks.push(check)
  })

  const preflight: Use[] = []
  const rawPreflight = root[`${prefix}preflight`]
  if (rawPreflight !== undefined) {
    if (!Array.isArray(rawPreflight)) {
      problem(`${prefix}preflight must be a list of checks to run.`)
    } else {
      rawPreflight.forEach((step, i) => {
        const where = `${prefix}preflight[${i}]`
        if (!isObj(step) || typeof step.check !== "string") {
          return problem(`${where} must name a check, such as { check: google.apiEnabled }.`)
        }
        const use = parseWith(step.with, where, problem)
        preflight.push({ from: step.check, with: use })
      })
    }
  }

  return { include, groups: [...groups.values()], lookups, checks, preflight, problems }
}

/** Read how one input uses lookups, from its entry under `variables`. */
export function parseInputLookups(
  raw: Obj,
  where: string,
  source: string,
  prefix: KeyPrefix = "",
): { lookups: InputLookups; problems: Problem[] } {
  const problems: Problem[] = []
  const problem = (message: string): void => {
    problems.push({ source, message })
  }
  const readUse = (key: string): Use | undefined => {
    const value = raw[`${prefix}${key}`]
    if (value === undefined) return undefined
    const at = `${where}.${prefix}${key}`
    if (!isObj(value) || typeof value.from !== "string") {
      problem(`${at} must name a lookup, such as { from: google.people }.`)
      return undefined
    }
    return { from: value.from, with: parseWith(value.with, at, problem) }
  }
  const shortcut = readUse("shortcut")
  const rawShortcut = raw[`${prefix}shortcut`]
  const label = isObj(rawShortcut) ? rawShortcut.label : undefined
  if (label !== undefined && typeof label !== "string") {
    problem(`${where}.${prefix}shortcut.label must be text.`)
  }
  const withLabel: ShortcutUse | undefined =
    shortcut && typeof label === "string" ? { ...shortcut, label } : shortcut
  return {
    lookups: { lookup: readUse("lookup"), prefill: readUse("prefill"), shortcut: withLabel },
    problems,
  }
}

function parseGroup(
  name: string,
  raw: unknown,
  where: string,
  problem: (message: string) => void,
): Group | undefined {
  if (!NAME.test(name)) {
    problem(`${where}: a group name is letters, digits, _ and -.`)
    return undefined
  }
  if (!isObj(raw)) {
    problem(`${where} must be a group: its auth, and its lookups or checks by name.`)
    return undefined
  }
  if (!AUTH_KINDS.includes(raw.auth as AuthKind)) {
    problem(
      `${where}.auth must name the kind of auth block the group needs: ${AUTH_KINDS.join(" or ")}.`,
    )
    return undefined
  }
  const scopes = stringList(raw.scopes, `${where}.scopes`, problem)
  return { name, auth: raw.auth as AuthKind, scopes }
}

const mergeScopes = (a: Group, b: Group): Group => ({
  ...a,
  scopes: [...new Set([...a.scopes, ...b.scopes])],
})

function parseRequest(
  raw: unknown,
  where: string,
  problem: (message: string) => void,
): RequestTemplate | undefined {
  if (!isObj(raw)) {
    problem(`${where}.request must be a request: its method, url, headers and body.`)
    return undefined
  }
  const method = raw.method ?? "GET"
  if (method !== "GET" && method !== "POST") {
    problem(`${where}.request.method must be GET or POST.`)
    return undefined
  }
  if (typeof raw.url !== "string" || raw.url === "") {
    problem(`${where}.request.url must be the request's URL.`)
    return undefined
  }
  const headers: Record<string, string> = {}
  if (raw.headers !== undefined) {
    if (!isObj(raw.headers)) {
      problem(`${where}.request.headers must map header names to values.`)
      return undefined
    }
    for (const [name, value] of Object.entries(raw.headers)) {
      if (typeof value !== "string") {
        problem(`${where}.request.headers.${name} must be text.`)
        return undefined
      }
      headers[name] = value
    }
  }
  if (method === "GET" && raw.body !== undefined) {
    problem(`${where}.request is a GET, which has no body.`)
    return undefined
  }
  return { method, url: raw.url, headers, ...(raw.body !== undefined ? { body: raw.body } : {}) }
}

function parseLookup(
  group: Group,
  name: string,
  raw: unknown,
  source: string,
  problem: (message: string) => void,
): LookupDef | undefined {
  const id = `${group.name}.${name}`
  if (!isObj(raw)) {
    problem(`Lookup ${id} must be a lookup: its request, rows and fields.`)
    return undefined
  }
  const request = parseRequest(raw.request, `Lookup ${id}`, problem)
  if (!request) return undefined

  if (raw.rows !== undefined && (typeof raw.rows !== "string" || raw.rows === "")) {
    problem(`Lookup ${id}: rows must be the path of the list in the response.`)
    return undefined
  }
  if (!isObj(raw.fields) || Object.keys(raw.fields).length === 0) {
    problem(`Lookup ${id} must declare its fields: each field's name and its path in a row.`)
    return undefined
  }
  const fields: Record<string, string> = {}
  for (const [field, path] of Object.entries(raw.fields)) {
    if (!NAME.test(field) || typeof path !== "string" || path === "") {
      problem(`Lookup ${id}: field ${field} must name a path in a row.`)
      return undefined
    }
    fields[field] = path
  }

  let next: Paging | undefined
  if (raw.next !== undefined) {
    const to = isObj(raw.next) ? raw.next.to : undefined
    if (
      !isObj(raw.next) ||
      typeof raw.next.from !== "string" ||
      typeof to !== "string" ||
      !/^(body|query)\.[\w.-]+$/.test(to)
    ) {
      problem(
        `Lookup ${id}: next must say where the token is and where it goes, such as { from: NextToken, to: body.NextToken } or { to: query.pageToken }.`,
      )
      return undefined
    }
    if (to.startsWith("body.") && request.method === "GET") {
      problem(`Lookup ${id}: a GET has no body, so next.to must be query.<name>.`)
      return undefined
    }
    next = { from: raw.next.from, to }
  }

  const maxPages = raw.maxPages ?? DEFAULT_MAX_PAGES
  if (
    typeof maxPages !== "number" ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > MAX_PAGES_LIMIT
  ) {
    problem(`Lookup ${id}: maxPages must be a whole number from 1 to ${MAX_PAGES_LIMIT}.`)
    return undefined
  }

  return {
    id,
    group: group.name,
    name,
    params: stringList(raw.params, `Lookup ${id}: params`, problem),
    request,
    rows: raw.rows as string | undefined,
    next,
    maxPages,
    fields,
    source,
  }
}

function parseCheck(
  group: Group,
  name: string,
  raw: unknown,
  source: string,
  problem: (message: string) => void,
): CheckDef | undefined {
  const id = `${group.name}.${name}`
  if (!isObj(raw)) {
    problem(`Check ${id} must be a check: its request, expect and message.`)
    return undefined
  }
  const request = parseRequest(raw.request, `Check ${id}`, problem)
  if (!request) return undefined
  const expect = parseExpect(raw.expect, `Check ${id}`, problem)
  if (!expect) return undefined
  if (typeof raw.message !== "string" || raw.message === "") {
    problem(`Check ${id} must have a message: what a failure means.`)
    return undefined
  }
  if (raw.fix !== undefined && typeof raw.fix !== "string") {
    problem(`Check ${id}: fix must be text, such as a link.`)
    return undefined
  }
  return {
    id,
    group: group.name,
    name,
    params: stringList(raw.params, `Check ${id}: params`, problem),
    request,
    expect,
    message: raw.message,
    fix: raw.fix as string | undefined,
    source,
  }
}

function parseExpect(
  raw: unknown,
  where: string,
  problem: (message: string) => void,
): Expectation | undefined {
  const usage = `${where}: expect must be { path, equals }, { path, exists } or { path, minRows }.`
  if (!isObj(raw) || typeof raw.path !== "string" || raw.path === "") {
    problem(usage)
    return undefined
  }
  const conditions = ["equals", "exists", "minRows"].filter((key) => raw[key] !== undefined)
  if (conditions.length !== 1) {
    problem(usage)
    return undefined
  }
  if (raw.equals !== undefined) {
    if (typeof raw.equals === "object") {
      problem(`${where}: expect.equals must be a single value.`)
      return undefined
    }
    return { path: raw.path, equals: String(raw.equals as string | number | boolean) }
  }
  if (raw.exists !== undefined) {
    if (typeof raw.exists !== "boolean") {
      problem(`${where}: expect.exists must be true or false.`)
      return undefined
    }
    return { path: raw.path, exists: raw.exists }
  }
  if (typeof raw.minRows !== "number" || !Number.isInteger(raw.minRows) || raw.minRows < 0) {
    problem(`${where}: expect.minRows must be a whole number.`)
    return undefined
  }
  return { path: raw.path, minRows: raw.minRows }
}

function parseWith(
  raw: unknown,
  where: string,
  problem: (message: string) => void,
): Record<string, string> {
  if (raw === undefined) return {}
  if (!isObj(raw)) {
    problem(`${where}.with must map param names to values.`)
    return {}
  }
  const values: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "object" || value === undefined) {
      problem(`${where}.with.${name} must be a single value.`)
      continue
    }
    values[name] = String(value as string | number | boolean)
  }
  return values
}

function stringList(raw: unknown, where: string, problem: (message: string) => void): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    problem(`${where} must be a list of names.`)
    return []
  }
  return raw as string[]
}
