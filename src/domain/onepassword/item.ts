/**
 * The <OnePasswordItem> block's work: save an item to a 1Password vault with
 * the 1Password CLI (`op`), as the user who is signed in to it.
 *
 * Secret values never go on the command line, where other processes can read
 * them: the item goes to `op item create` as JSON on stdin. Only the vault,
 * the website and the tags, which aren't secret, are flags.
 */
import { Effect } from "effect"
import { Environment } from "../../services/Environment.ts"
import { ProcessSpawner, collectOutput } from "../../services/ProcessSpawner.ts"
import { OnePasswordError } from "../../errors/index.ts"
import { errorMessage } from "../../errors/message.ts"

/** The item categories the block offers, by the name 1Password shows. */
export const ONE_PASSWORD_CATEGORIES = {
  Login: "LOGIN",
  Password: "PASSWORD",
  "API Credential": "API_CREDENTIAL",
  "Secure Note": "SECURE_NOTE",
  Server: "SERVER",
  Database: "DATABASE",
} as const

export type OnePasswordCategory = keyof typeof ONE_PASSWORD_CATEGORIES

export const ONE_PASSWORD_FIELD_TYPES = ["text", "concealed", "url", "email"] as const
export type OnePasswordFieldType = (typeof ONE_PASSWORD_FIELD_TYPES)[number]

export interface OnePasswordField {
  readonly label: string
  readonly value: string
  /** Defaults to `concealed`, since the block is for credentials. */
  readonly type?: OnePasswordFieldType | undefined
}

/** What the block saves, with its templates rendered. */
export interface OnePasswordItemRequest {
  readonly vault: string
  readonly title: string
  readonly category: OnePasswordCategory
  readonly username?: string | undefined
  readonly password?: string | undefined
  readonly url?: string | undefined
  readonly notes?: string | undefined
  readonly tags?: readonly string[] | undefined
  readonly fields?: readonly OnePasswordField[] | undefined
  /** The account to use when several are signed in: its shorthand, sign-in address or ID. */
  readonly account?: string | undefined
}

export interface OnePasswordItemResult {
  readonly itemId: string
  readonly title: string
  readonly vaultId: string
  readonly vaultName: string
}

/** Why `request` can't be saved, or undefined when it can. Checks the props, not their values. */
export function onePasswordItemRequestError(request: {
  vault?: string | undefined
  title?: string | undefined
  category?: string | undefined
  fields?: readonly { label?: unknown; value?: unknown; type?: unknown }[] | undefined
}): string | undefined {
  if (!request.vault?.trim()) return "The item needs a vault (the `vault` prop)."
  if (!request.title?.trim()) return "The item needs a title (the `itemTitle` prop)."
  if (request.category !== undefined && !(request.category in ONE_PASSWORD_CATEGORIES)) {
    return `Category "${request.category}" is not one of ${Object.keys(ONE_PASSWORD_CATEGORIES).join(", ")}.`
  }
  for (const [index, field] of (request.fields ?? []).entries()) {
    if (typeof field?.label !== "string" || !field.label.trim()) {
      return `Field ${index + 1} needs a label.`
    }
    if (typeof field.value !== "string") return `Field "${field.label}" needs a string value.`
    if (
      field.type !== undefined &&
      !(ONE_PASSWORD_FIELD_TYPES as readonly unknown[]).includes(field.type)
    ) {
      return `Field "${field.label}" has type ${JSON.stringify(field.type)}, which is not one of ${ONE_PASSWORD_FIELD_TYPES.join(", ")}.`
    }
  }
  return undefined
}

const FIELD_TYPES: Record<OnePasswordFieldType, string> = {
  text: "STRING",
  concealed: "CONCEALED",
  url: "URL",
  email: "EMAIL",
}

/** A field id from its label: lowercase letters, digits and underscores, unique in the item. */
function fieldId(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "field"
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`
  taken.add(id)
  return id
}

/**
 * The item as `op item create` reads it on stdin. A Login keeps the username
 * and password in its own username and password fields, and an API Credential
 * the password in its credential field, so 1Password fills and shows them as
 * it does for items made in the app.
 */
export function itemTemplate(request: OnePasswordItemRequest): Record<string, unknown> {
  const category = ONE_PASSWORD_CATEGORIES[request.category]
  const taken = new Set<string>()
  const fields: Array<Record<string, string>> = []

  if (request.username) {
    taken.add("username")
    fields.push({
      id: "username",
      type: "STRING",
      label: "username",
      value: request.username,
      ...(category === "LOGIN" ? { purpose: "USERNAME" } : {}),
    })
  }
  if (request.password) {
    const id = category === "API_CREDENTIAL" ? "credential" : "password"
    taken.add(id)
    fields.push({
      id,
      type: "CONCEALED",
      label: id,
      value: request.password,
      ...(category === "LOGIN" || category === "PASSWORD" ? { purpose: "PASSWORD" } : {}),
    })
  }
  if (request.notes) {
    taken.add("notesPlain")
    fields.push({
      id: "notesPlain",
      type: "STRING",
      purpose: "NOTES",
      label: "notesPlain",
      value: request.notes,
    })
  }
  for (const field of request.fields ?? []) {
    fields.push({
      id: fieldId(field.label, taken),
      type: FIELD_TYPES[field.type ?? "concealed"],
      label: field.label,
      value: field.value,
    })
  }

  return { title: request.title, category, fields }
}

/** The values to keep out of anything `op` prints, should it ever echo one. */
function secretsOf(request: OnePasswordItemRequest): string[] {
  return [
    request.password,
    ...(request.fields ?? [])
      .filter((field) => (field.type ?? "concealed") === "concealed")
      .map((field) => field.value),
  ].filter((value): value is string => !!value)
}

function scrub(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, secret) => out.split(secret).join("<redacted>"), text)
}

/** How long `op` may take, including the user approving it in the 1Password app. */
const OP_TIMEOUT_MS = 120_000

const SIGN_IN_HINT =
  "Sign in to the 1Password CLI, or turn on Settings > Developer > Integrate with 1Password CLI in the 1Password app, then try again."

function opFailure(stderr: string, secrets: readonly string[]): OnePasswordError {
  const text = scrub(stderr.replace(/^\[ERROR\]\s*\S+\s+\S+\s*/m, "").trim(), secrets)
  const signIn =
    /not signed in|no accounts configured|sign in|authorization (?:prompt )?(?:dismissed|denied)/i
  return new OnePasswordError({
    message: signIn.test(text) ? `${text} ${SIGN_IN_HINT}` : text || "The 1Password CLI failed.",
  })
}

/** Run `op` with `args`, and `stdin` if given. Fails with what `op` said. */
const runOp = (args: string[], secrets: readonly string[], stdin?: string) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const environment = yield* Environment
    const env = yield* environment.getAll()
    const proc = yield* spawner.spawn("op", args, { env, ...(stdin ? { stdin } : {}) }).pipe(
      Effect.mapError((err) => {
        const cause = (err as { cause?: { code?: unknown } }).cause
        return new OnePasswordError({
          message:
            cause?.code === "ENOENT" || errorMessage(err).includes("ENOENT")
              ? "The 1Password CLI (op) isn't installed, or isn't on your PATH. Install it from https://developer.1password.com/docs/cli/get-started/."
              : `Couldn't run the 1Password CLI: ${errorMessage(err)}`,
        })
      }),
    )
    const { exitCode, lines } = yield* collectOutput(proc, OP_TIMEOUT_MS).pipe(
      Effect.mapError(
        () =>
          new OnePasswordError({
            message:
              "The 1Password CLI didn't answer within two minutes. Did 1Password ask you to approve it?",
          }),
      ),
    )
    const stdout = lines.filter((line) => line.source === "stdout").map((line) => line.line)
    const stderr = lines.filter((line) => line.source === "stderr").map((line) => line.line)
    if (exitCode !== 0) return yield* Effect.fail(opFailure(stderr.join("\n"), secrets))
    return stdout.join("\n")
  })

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new OnePasswordError({ message: `The 1Password CLI returned ${what} that isn't JSON.` })
  }
}

/**
 * Save the item, unless the vault already has an item with this title: the
 * block never adds a second item that could be taken for the first, or
 * changes one it didn't make.
 */
export const createOnePasswordItem = (request: OnePasswordItemRequest) =>
  Effect.gen(function* () {
    const invalid = onePasswordItemRequestError(request)
    if (invalid) return yield* Effect.fail(new OnePasswordError({ message: invalid }))

    const secrets = secretsOf(request)
    const account = request.account?.trim() ? ["--account", request.account.trim()] : []
    const vault = request.vault.trim()
    const title = request.title.trim()

    const listed = yield* runOp(
      ["item", "list", "--vault", vault, "--format", "json", ...account],
      secrets,
    )
    const items = yield* Effect.try({
      try: () => parseJson(listed || "[]", "a list of items"),
      catch: (err) => err as OnePasswordError,
    })
    if (
      Array.isArray(items) &&
      items.some((item) => (item as { title?: unknown })?.title === title)
    ) {
      return yield* Effect.fail(
        new OnePasswordError({
          message: `The ${vault} vault already has an item named "${title}". Rename or delete it, or give this item another title.`,
        }),
      )
    }

    const flags = [
      ...(request.url?.trim() ? ["--url", request.url.trim()] : []),
      ...(request.tags?.length
        ? [
            "--tags",
            request.tags
              .map((tag) => tag.trim())
              .filter(Boolean)
              .join(","),
          ]
        : []),
    ]
    const created = yield* runOp(
      ["item", "create", "--vault", vault, "--format", "json", ...flags, ...account, "-"],
      secrets,
      JSON.stringify(itemTemplate({ ...request, vault, title })),
    )
    const item = (yield* Effect.try({
      try: () => parseJson(created, "an item"),
      catch: (err) => err as OnePasswordError,
    })) as { id?: unknown; title?: unknown; vault?: { id?: unknown; name?: unknown } }
    if (typeof item.id !== "string") {
      return yield* Effect.fail(
        new OnePasswordError({ message: "The 1Password CLI didn't say which item it created." }),
      )
    }
    return {
      itemId: item.id,
      title: typeof item.title === "string" ? item.title : title,
      vaultId: typeof item.vault?.id === "string" ? item.vault.id : "",
      vaultName: typeof item.vault?.name === "string" ? item.vault.name : vault,
    } satisfies OnePasswordItemResult
  })
