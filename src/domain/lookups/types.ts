/**
 * The lookup and check format, as the engine reads it after parsing. A lookup
 * fetches rows from an API to suggest or fill a form field; a check is a read
 * request plus a condition. Modules and forms declare both, and the engine
 * knows no API: the auth block a group is bound to sends each request.
 */

/** The kinds of auth block a group can need. Each sends only what its own rules allow. */
export const AUTH_KINDS = ["AwsAuth", "GoogleAuth"] as const
export type AuthKind = (typeof AUTH_KINDS)[number]

/** What each kind of auth block knows about its sign-in, for templates to read as `.auth`. */
export const AUTH_FACTS: Readonly<Record<AuthKind, readonly string[]>> = {
  AwsAuth: ["region", "ssoRegion", "accountId"],
  GoogleAuth: ["email", "project"],
}

/** A set of lookups and checks that share an auth block, keyed by a name the module picks. */
export interface Group {
  readonly name: string
  readonly auth: AuthKind
  /** OAuth scopes the group's requests need, for auth blocks that have scopes. */
  readonly scopes: readonly string[]
}

/** A request as declared: every string in it may hold templates. */
export interface RequestTemplate {
  readonly method: "GET" | "POST"
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** A JSON value, sent as JSON, or as a form when Content-Type says so. */
  readonly body?: unknown
}

/** Where the next page's token is in a response, and where the next request puts it. */
export interface Paging {
  /** A path in the response, such as `NextToken`. */
  readonly from: string
  /** `body.<path>` or `query.<name>`. */
  readonly to: string
}

export interface LookupDef {
  /** `<group>.<name>`. */
  readonly id: string
  readonly group: string
  readonly name: string
  readonly params: readonly string[]
  readonly request: RequestTemplate
  /** Where the list of results is in the response; absent when the response is the one row. */
  readonly rows?: string | undefined
  readonly next?: Paging | undefined
  readonly maxPages: number
  /** The lookup's contract: each field it gives, and its path in a row. */
  readonly fields: Readonly<Record<string, string>>
  /** The file it was defined in, for messages. */
  readonly source: string
}

export type Expectation =
  | { readonly path: string; readonly equals: string }
  | { readonly path: string; readonly exists: boolean }
  | { readonly path: string; readonly minRows: number }

export interface CheckDef {
  readonly id: string
  readonly group: string
  readonly name: string
  readonly params: readonly string[]
  readonly request: RequestTemplate
  readonly expect: Expectation
  /** What a failed check shows: a template over `.params`, `.auth` and `.inputs`. */
  readonly message: string
  /** A link or a step that fixes a failed check, as a template too. */
  readonly fix?: string | undefined
  readonly source: string
}

/** Every lookup and check a module or form can use, from its own file and its includes. */
export interface Definitions {
  readonly groups: Readonly<Record<string, Group>>
  readonly lookups: Readonly<Record<string, LookupDef>>
  readonly checks: Readonly<Record<string, CheckDef>>
}

/** A use of a lookup or a check: which one, and the values of its params, as templates over `.inputs`. */
export interface Use {
  readonly from: string
  readonly with: Readonly<Record<string, string>>
}

/** A shortcut also has its button's text, a template over the row's fields. */
export interface ShortcutUse extends Use {
  readonly label?: string | undefined
}

/** How one input uses lookups. */
export interface InputLookups {
  readonly lookup?: Use | undefined
  readonly prefill?: Use | undefined
  readonly shortcut?: ShortcutUse | undefined
}

/** A row a lookup gave: its declared fields only. */
export type Row = Readonly<Record<string, unknown>>

/** A problem with a declaration, found when the file loads. */
export interface Problem {
  readonly source: string
  readonly message: string
}
