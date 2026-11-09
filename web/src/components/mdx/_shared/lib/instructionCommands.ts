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

export interface GcloudGroupArgs {
  email: string
  displayName?: string | undefined
  description?: string | undefined
  customerId?: string | undefined
  members?: readonly string[] | undefined
  role?: "MEMBER" | "MANAGER" | "OWNER" | undefined
}

/**
 * `gcloud identity groups create …`, then one `memberships add` per member.
 * The group belongs to the organization named for the email's domain unless a
 * customer ID is given, as in the app.
 */
export function buildGcloudGroupCommands({
  email,
  displayName,
  description,
  customerId,
  members,
  role = "MEMBER",
}: GcloudGroupArgs): string[] {
  const groupEmail = email || "<group-email>"
  const at = email.indexOf("@")
  const create = [`gcloud identity groups create ${shellQuote(groupEmail)}`]
  if (customerId) create.push(`--customer=${shellQuote(customerId)}`)
  else create.push(`--organization=${shellQuote(at >= 0 ? email.slice(at + 1) : "<domain>")}`)
  create.push(
    `--display-name=${shellQuote(displayName || (at >= 0 ? email.slice(0, at) : groupEmail))}`,
  )
  if (description) create.push(`--description=${shellQuote(description)}`)
  create.push("--with-initial-owner=WITH_INITIAL_OWNER")

  const roles = role === "MEMBER" ? "MEMBER" : `MEMBER,${role}`
  const adds = (members ?? [])
    .filter((member) => member)
    .map((member) =>
      [
        "gcloud identity groups memberships add",
        `--group-email=${shellQuote(groupEmail)}`,
        `--member-email=${shellQuote(member)}`,
        `--roles=${roles}`,
      ].join(" \\\n  "),
    )
  return [create.join(" \\\n  "), ...adds]
}
