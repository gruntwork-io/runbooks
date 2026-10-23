/**
 * The `env` prop of a <Command>, <Check> or <Finish> block: environment
 * variables its script runs with, by name.
 *
 *   <Command
 *     env={{ BUCKET: "{{ .inputs.BucketName }}", PR_TITLE: "{{ .outputs.fetch_pr.TITLE }}" }}
 *     command={`aws s3 mb "s3://$BUCKET"`}
 *   />
 *
 * Each value is a template, rendered with the same `.inputs` / `.outputs` as
 * the script, and reaches the script as data: the shell never parses it as
 * code, whatever it contains. The variables are the block's own. They don't
 * stay in the session for the blocks after it.
 *
 * Imports nothing, so the renderer can bundle it.
 */

/** A block's env templates by variable name, as `parseBlockEnv` accepts them. */
export type BlockEnv = Readonly<Record<string, string>>

export type ParsedBlockEnv =
  | { readonly ok: true; readonly env: BlockEnv }
  | { readonly ok: false; readonly error: string }

// A name every shell can export: what POSIX allows for an env var name.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Whether Runbooks sets `name` itself for every run: RUNBOOK_OUTPUT, the log
 * files (RUNBOOK_LOG, RUNBOOK_INFO_LOG, ...), GENERATED_FILES and REPO_FILES.
 * The RUNBOOK_ prefix is kept for those.
 */
function isRunbookEnvVar(name: string): boolean {
  return name.startsWith("RUNBOOK_") || name === "GENERATED_FILES" || name === "REPO_FILES"
}

/**
 * Check a block's `env` prop. A block without one has an empty env. A number
 * or boolean value becomes its text, as a template would print it.
 */
export function parseBlockEnv(value: unknown): ParsedBlockEnv {
  if (value === undefined) return { ok: true, env: {} }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error:
        "The env prop must be an object of variable names and values, such as " +
        'env={{ BUCKET: "{{ .inputs.BucketName }}" }}.',
    }
  }

  const entries: Array<[string, string]> = []
  for (const [name, item] of Object.entries(value)) {
    if (!ENV_NAME.test(name)) {
      return {
        ok: false,
        error: `"${name}" in env is not a variable name. Use letters, digits and underscores, and don't start with a digit.`,
      }
    }
    if (isRunbookEnvVar(name)) {
      return {
        ok: false,
        error: `${name} in env is a variable Runbooks sets for every script. Pick another name.`,
      }
    }
    if (typeof item === "string") {
      entries.push([name, item])
    } else if (typeof item === "number" || typeof item === "boolean") {
      entries.push([name, String(item)])
    } else {
      return {
        ok: false,
        error: `${name} in env must be a string, number or boolean.`,
      }
    }
  }
  return { ok: true, env: Object.fromEntries(entries) }
}

/** Whether two blocks' envs set the same variables to the same templates. */
export function sameBlockEnv(a: BlockEnv, b: BlockEnv): boolean {
  const names = Object.keys(a)
  return names.length === Object.keys(b).length && names.every((name) => b[name] === a[name])
}

/**
 * `value` quoted for a POSIX shell: in single quotes, which leave everything
 * in them as it is, with each `'` in it written as `'\''`.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** `export NAME='value'` lines that set `env` in a shell, one per variable. */
export function exportLines(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
    .join("\n")
}
