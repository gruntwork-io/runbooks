/**
 * Builders that turn a git/git-host/boilerplate block's resolved props into the
 * exact copy-pasteable command a user would run by hand in instruction mode
 * (spec §6.4). Pure and framework-agnostic so they can be unit-tested directly.
 */

/** Single-quote a value for a POSIX shell, escaping embedded single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface GitCloneArgs {
  url: string
  ref?: string | undefined
  /** Destination directory (the resolved local path). */
  localPath?: string | undefined
}

/**
 * `git clone [--branch <ref>] <url> [<dir>]`. Sparse-checkout for a sub-path is
 * surfaced as a separate note by the caller, not folded into this one-liner.
 */
export function buildGitCloneCommand({ url, ref, localPath }: GitCloneArgs): string {
  const parts = ["git clone"]
  if (ref) parts.push(`--branch ${shellQuote(ref)}`)
  parts.push(url ? shellQuote(url) : "<repository-url>")
  if (localPath) parts.push(shellQuote(localPath))
  return parts.join(" ")
}

export interface GhPrArgs {
  title: string
  body?: string
  labels?: string[]
  branch?: string
}

/**
 * `gh pr create --title <…> --body <…> [--label <…>]`. The branch is surfaced as
 * a note by the caller (the user must push it first).
 */
export function buildGhPrCommand({ title, body, labels }: GhPrArgs): string {
  const parts = ["gh pr create"]
  parts.push(`--title ${shellQuote(title || "<pull request title>")}`)
  parts.push(`--body ${shellQuote(body ?? "")}`)
  for (const label of labels ?? []) {
    if (label) parts.push(`--label ${shellQuote(label)}`)
  }
  return parts.join(" \\\n  ")
}

export interface GlabMrArgs {
  title: string
  description?: string
  labels?: string[]
  branch?: string
}

/**
 * `glab mr create --title <…> --description <…> [--label <…>]`. GitLab's CLI uses
 * `--description` (not `--body`) and defaults the source to the current branch,
 * so — like the gh builder — the branch is surfaced as a note (the user must
 * push it first) rather than folded into the command.
 */
export function buildGlabMrCommand({ title, description, labels }: GlabMrArgs): string {
  const parts = ["glab mr create"]
  parts.push(`--title ${shellQuote(title || "<merge request title>")}`)
  parts.push(`--description ${shellQuote(description ?? "")}`)
  for (const label of labels ?? []) {
    if (label) parts.push(`--label ${shellQuote(label)}`)
  }
  return parts.join(" \\\n  ")
}

export interface BoilerplateArgs {
  /** The boilerplate template directory (the block's `path`). */
  path: string
  /** Collected variable values from the form. */
  variables: Record<string, unknown>
  /** Where the block would have written output. */
  target?: "generated" | "worktree" | undefined
}

/**
 * A `boilerplate` CLI invocation equivalent to what the Generate button would
 * run — template dir, output folder, and one `--var name=value` per collected
 * variable. Complex values (lists/maps) are JSON-encoded. No files are written.
 */
export function buildBoilerplateInvocation({ path, variables, target }: BoilerplateArgs): string {
  const outputFolder = target === "worktree" ? "<repo-directory>" : "./generated"
  const parts = [
    `boilerplate --template-url ${shellQuote(path || "<template-path>")} --output-folder ${shellQuote(outputFolder)} --non-interactive`,
  ]
  for (const [name, value] of Object.entries(variables)) {
    if (value === undefined || value === null || value === "") continue
    const rendered = typeof value === "string" ? value : JSON.stringify(value)
    parts.push(`--var ${shellQuote(`${name}=${rendered}`)}`)
  }
  return parts.join(" \\\n  ")
}

export interface OpItemArgs {
  vault: string
  title: string
  category?: string | undefined
  username?: string | undefined
  password?: string | undefined
  url?: string | undefined
  notes?: string | undefined
  tags?: readonly string[] | undefined
  fields?: ReadonlyArray<{ label: string; value: string; type?: string | undefined }> | undefined
  account?: string | undefined
}

const OP_ASSIGNMENT_TYPES: Record<string, string> = {
  text: "text",
  concealed: "password",
  url: "url",
  email: "email",
}

/**
 * `op item create …` with each field as an assignment statement, which is
 * how a person types it. Field labels have `.`, `=` and `\` escaped, as
 * assignment syntax needs.
 */
export function buildOpItemCreateCommand({
  vault,
  title,
  category = "Login",
  username,
  password,
  url,
  notes,
  tags,
  fields,
  account,
}: OpItemArgs): string {
  const escapeLabel = (label: string) => label.replace(/([\\.=])/g, "\\$1")
  const parts = [
    "op item create",
    `--vault ${shellQuote(vault || "<vault>")}`,
    `--category ${shellQuote(category)}`,
    `--title ${shellQuote(title || "<title>")}`,
  ]
  if (url) parts.push(`--url ${shellQuote(url)}`)
  if (tags?.length) parts.push(`--tags ${shellQuote(tags.join(","))}`)
  if (account) parts.push(`--account ${shellQuote(account)}`)
  if (username) parts.push(shellQuote(`username=${username}`))
  if (password) {
    parts.push(
      shellQuote(`${category === "API Credential" ? "credential" : "password"}=${password}`),
    )
  }
  if (notes) parts.push(shellQuote(`notesPlain=${notes}`))
  for (const field of fields ?? []) {
    const type = OP_ASSIGNMENT_TYPES[field.type ?? "concealed"] ?? "password"
    parts.push(shellQuote(`${escapeLabel(field.label)}[${type}]=${field.value}`))
  }
  return parts.join(" \\\n  ")
}
