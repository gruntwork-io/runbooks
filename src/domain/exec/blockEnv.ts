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
 * Also the block's `workingDir` prop, and the names a script can't set for
 * the session through RUNBOOK_ENV.
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
 * Whether Runbooks sets `name` itself for every run: RUNBOOK_OUTPUT,
 * RUNBOOK_ENV, the log files (RUNBOOK_INFO_LOG, ...),
 * GENERATED_FILES and REPO_FILES.
 * The RUNBOOK_ prefix is kept for those.
 */
export function isRunbookEnvVar(name: string): boolean {
  return name.startsWith("RUNBOOK_") || name === "GENERATED_FILES" || name === "REPO_FILES"
}

/** Variables that make a shell, the dynamic linker or a language runtime run code as it starts. */
const STARTUP_ENV_VARS = new Set([
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "NODE_OPTIONS",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "RUBYOPT",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
])

/**
 * Whether `name` makes the programs a later block starts run code it names:
 * BASH_ENV, NODE_OPTIONS, LD_PRELOAD and the like, and bash's exported
 * functions (BASH_FUNC_*). A value a script copies into RUNBOOK_ENV from
 * outside, such as a PR title with a newline in it, can add a line that sets
 * one, so RUNBOOK_ENV refuses them.
 */
export function isStartupEnvVar(name: string): boolean {
  return (
    STARTUP_ENV_VARS.has(name) ||
    name.startsWith("BASH_FUNC_") ||
    name.startsWith("LD_") ||
    name.startsWith("DYLD_")
  )
}

export type ParsedInterpreter =
  | { readonly ok: true; readonly interpreter: string }
  | { readonly ok: false; readonly error: string }

/**
 * Check a block's `interpreter` prop against its script: a program on PATH,
 * with optional args (`interpreter="deno run"`), that runs a script without a
 * shebang. A block without one has an empty interpreter. A script that has a
 * shebang can't also have the prop: a terminal would run it with the shebang's
 * program, and only Runbooks would read the prop.
 */
export function parseBlockInterpreter(value: unknown, script: string): ParsedInterpreter {
  if (value === undefined) return { ok: true, interpreter: "" }
  if (typeof value !== "string" || value.trim() === "") {
    return {
      ok: false,
      error: 'The interpreter prop must name a program, such as interpreter="python3".',
    }
  }
  if (script.startsWith("#!")) {
    return {
      ok: false,
      error:
        "The script starts with a shebang line, and the block sets the interpreter prop. " +
        "Remove one of them.",
    }
  }
  return { ok: true, interpreter: value.trim() }
}

export type ParsedWorkingDir =
  | { readonly ok: true; readonly workingDir: string }
  | { readonly ok: false; readonly error: string }

/**
 * Check a block's `workingDir` prop: a path, absolute or relative to the
 * session's directory, that may hold templates. A block without one runs in
 * the session's directory and has an empty workingDir.
 */
export function parseBlockWorkingDir(value: unknown): ParsedWorkingDir {
  if (value === undefined) return { ok: true, workingDir: "" }
  if (typeof value !== "string" || value === "") {
    return {
      ok: false,
      error: 'The workingDir prop must be a path, such as workingDir="infra/live".',
    }
  }
  return { ok: true, workingDir: value }
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
