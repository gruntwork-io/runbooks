/**
 * Script preparation, and parsing of the files a script writes for Runbooks
 * to read back: RUNBOOK_OUTPUT, RUNBOOK_ENV and GENERATED_FILES.
 */
import path from "node:path"
import { Effect, type Scope } from "effect"
import { FileSystem } from "../../services/FileSystem.ts"
import type { FileWriteError, FileReadError, FileNotFoundError } from "../../errors/index.ts"
import type { CapturedFile } from "../../types.ts"
import { sensitiveOutput, type OutputValues } from "./outputValues.ts"
import { isRunbookEnvVar, isStartupEnvVar } from "./blockEnv.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Logging functions put before every bash and sh script: log_info, log_warn,
 * log_error and log_debug. They're POSIX sh plus `local`, which dash and
 * every other /bin/sh Runbooks meets supports.
 *
 * All four append to the one file named by RUNBOOK_LOG (see logChannels.ts),
 * so their lines keep the order the script wrote them in, and each line names
 * its level. They never write to stdout, so a function that logs and then
 * prints a value returns only that value through `$(...)`. When RUNBOOK_LOG
 * is unset, or the file can't be written (a background job still logging
 * after the run ended and the file was deleted), they write to stderr
 * instead of failing. Keep in sync with scripts/logging.sh.
 */
const LOGGING_FUNCTIONS = `
# --- Runbooks Logging Functions ---
# (auto-injected; see also scripts/logging.sh for local development)
_RUNBOOKS_LOGGING_LOADED=1

_log_timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# _log_write TAG MESSAGE...: append a line to $RUNBOOK_LOG, or write it to
# stderr if RUNBOOK_LOG is unset or the append fails
_log_write() {
    local tag="$1"
    shift
    if [ -n "\${RUNBOOK_LOG:-}" ] &&
        { printf '[%s] %s %s\\n' "$(_log_timestamp)" "$tag" "$*" >> "$RUNBOOK_LOG"; } 2>/dev/null; then
        return 0
    fi
    printf '[%s] %s %s\\n' "$(_log_timestamp)" "$tag" "$*" >&2
}

log_info() {
    _log_write "[INFO] " "$@"
}

log_warn() {
    _log_write "[WARN] " "$@"
}

log_error() {
    _log_write "[ERROR]" "$@"
}

log_debug() {
    if [ "\${DEBUG:-}" = "true" ]; then
        _log_write "[DEBUG]" "$@"
    fi
}
# --- End Runbooks Logging Functions ---
`

/** Valid shell/output identifier: starts with a letter or underscore, rest alphanumeric or underscore. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A script written to disk, and the command line that runs it. */
export interface ScriptSetup {
  readonly scriptPath: string
  readonly command: string
  /** The command's args, ending with the script's path when `command` is an interpreter. */
  readonly args: string[]
}

/**
 * How to start a script: `self` executes the script file, so the OS starts
 * the interpreter its shebang names, as a terminal would. `interpreter` runs
 * `command` with `args` and then the script file.
 */
type ScriptLaunch =
  | { readonly kind: "self" }
  | { readonly kind: "interpreter"; readonly command: string; readonly args: readonly string[] }

export type ScriptRunner =
  | {
      readonly ok: true
      readonly launch: ScriptLaunch
      /** The content to write to the script file. */
      readonly script: string
      /** The name to give the script file. It keeps the script's extension, which pwsh requires. */
      readonly fileName: string
    }
  | { readonly ok: false; readonly error: string }

// ---------------------------------------------------------------------------
// Interpreter Detection
// ---------------------------------------------------------------------------

/** The program that runs a script file without a shebang, by the file's extension. */
const INTERPRETER_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "zsh",
  ".py": "python3",
  ".js": "node",
  ".mjs": "node",
  ".cjs": "node",
  ".rb": "ruby",
  ".pl": "perl",
  ".ps1": "pwsh",
}

/** The interpreters whose scripts get the log_* functions. */
const SHELL_INTERPRETERS = new Set(["bash", "sh"])

/**
 * The program a `#!` line starts, by name, and its args. For `env` it is the
 * program env runs: env's options and NAME=value settings are skipped, and
 * `-S` only splits the rest of the line, which the words already are.
 * Returns undefined for a line that names no program.
 */
function shebangCommand(line: string): { command: string; args: string[] } | undefined {
  const words = line.slice(2).trim().split(/\s+/).filter(Boolean)
  const first = words.shift()
  if (first === undefined) return undefined
  const name = path.basename(first)
  if (name !== "env") return { command: name, args: words }

  while (words.length > 0) {
    const word = words[0]!
    if (word === "-u" || word === "--unset") {
      words.splice(0, 2)
    } else if (word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      words.shift()
    } else {
      break
    }
  }
  const command = words.shift()
  return command === undefined ? undefined : { command: path.basename(command), args: words }
}

/** Where a block's script comes from, and the props that pick its interpreter. */
export interface ScriptSource {
  /** The block's `path` prop, or "" for an inline `command`. */
  readonly path: string
  /** The block's `interpreter` prop, or "" for none (see parseBlockInterpreter). */
  readonly interpreter: string
}

/**
 * How to run a script, and what to write to its file.
 *
 * On macOS and Linux a script with a shebang runs as itself, so the shebang
 * means what it means in a terminal. Windows can't run a file by its shebang,
 * so there Runbooks starts the program the shebang names. A script without a
 * shebang runs with the block's `interpreter` prop, else with the program
 * for its file's extension (.py with python3, .js with node, ...). An inline
 * command or a file without an extension runs with bash. A file whose
 * extension has no program fails: it needs a shebang or the prop. The
 * registry refuses a block with both a shebang and the prop; a script file
 * that gains a shebang after that runs with the shebang.
 *
 * A bash or sh script gets the log_* functions, after its shebang line.
 */
export function resolveScriptRunner(
  content: string,
  source: ScriptSource,
  platform: NodeJS.Platform,
): ScriptRunner {
  const scriptPath = source.path
  const extension = path.extname(scriptPath).toLowerCase()
  const fileName = `script${extension || ".sh"}`
  const withLogging = (shebangLine: string, rest: string) =>
    shebangLine === ""
      ? `${LOGGING_FUNCTIONS}\n${rest}`
      : `${shebangLine}\n${LOGGING_FUNCTIONS}\n${rest}`

  const newline = content.indexOf("\n")
  const firstLine = newline === -1 ? content : content.slice(0, newline)
  const shebang = firstLine.startsWith("#!") ? shebangCommand(firstLine) : undefined
  if (shebang !== undefined) {
    const rest = newline === -1 ? "" : content.slice(newline + 1)
    const script = SHELL_INTERPRETERS.has(shebang.command) ? withLogging(firstLine, rest) : content
    const launch: ScriptLaunch =
      platform === "win32"
        ? { kind: "interpreter", command: shebang.command, args: shebang.args }
        : { kind: "self" }
    return { ok: true, launch, script, fileName }
  }

  const [propCommand, ...propArgs] = source.interpreter.split(/\s+/).filter(Boolean)
  const command = propCommand ?? (extension === "" ? "bash" : INTERPRETER_BY_EXTENSION[extension])
  if (command === undefined) {
    return {
      ok: false,
      error:
        `Runbooks can't tell which program runs ${path.basename(scriptPath)}. ` +
        `Add a shebang line, such as #!/usr/bin/env python3, to the top of the script, ` +
        `or set the block's interpreter prop.`,
    }
  }
  const script = SHELL_INTERPRETERS.has(path.basename(command)) ? withLogging("", content) : content
  return { ok: true, launch: { kind: "interpreter", command, args: propArgs }, script, fileName }
}

// ---------------------------------------------------------------------------
// Script Preparation (Effectful)
// ---------------------------------------------------------------------------

/**
 * Write the script `runner` describes (see resolveScriptRunner) to a new
 * directory in `scriptsDir`, executable by the user only, and return how to
 * run it. The directory is removed when the Effect Scope closes.
 *
 * `scriptsDir` is created if missing. It should be outside the OS temp
 * directory, which hardened Linux systems mount noexec.
 */
export const prepareScript = (
  runner: Extract<ScriptRunner, { ok: true }>,
  scriptsDir: string,
): Effect.Effect<ScriptSetup, FileWriteError, FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    yield* fs.mkdir(scriptsDir, { recursive: true })
    const scriptDir = yield* fs.mkdtemp("run-", scriptsDir)
    yield* Effect.addFinalizer(() =>
      fs.rm(scriptDir, { recursive: true, force: true }).pipe(Effect.ignore),
    )
    const scriptPath = `${scriptDir}/${runner.fileName}`
    yield* fs.writeFile(scriptPath, runner.script)
    yield* fs.chmod(scriptPath, 0o700)

    const { launch } = runner
    return launch.kind === "self"
      ? { scriptPath, command: scriptPath, args: [] }
      : { scriptPath, command: launch.command, args: [...launch.args, scriptPath] }
  })

// ---------------------------------------------------------------------------
// Session Env Parsing
// ---------------------------------------------------------------------------

/** The variables a script wrote to RUNBOOK_ENV, and a log line for each line that set none. */
export interface RunbookEnv {
  readonly env: Record<string, string>
  readonly problems: string[]
}

/** The most problems parseRunbookEnvContent reports one by one; a last line counts the rest. */
const MAX_REPORTED_PROBLEMS = 20

/**
 * Parse the contents of a RUNBOOK_ENV file: the variables a script sets for
 * the blocks after it. Pure, so the test CLI shares this parser with the app.
 *
 * Each variable is a line `NAME=value`, or, for a value with newlines in it,
 * `NAME<<DELIMITER`, the value's lines, then a line that is exactly
 * DELIMITER. Values are taken as written: quotes are part of the value. A
 * later line for the same name wins.
 *
 * A line is skipped, with a log line in `problems`, when it isn't valid,
 * names a variable Runbooks sets for every run (isRunbookEnvVar) or one that
 * makes later programs run code (isStartupEnvVar), or has a NUL character in
 * its value, which no process environment can hold.
 */
export function parseRunbookEnvContent(content: string): RunbookEnv {
  const env = new Map<string, string>()
  const problems: string[] = []
  let unreported = 0
  const skip = (lineNo: number, message: string, consequence = "The line was ignored.") => {
    if (problems.length < MAX_REPORTED_PROBLEMS) {
      problems.push(`RUNBOOK_ENV line ${lineNo}: ${message}. ${consequence}`)
    } else {
      unreported++
    }
  }
  // A file written on Windows ends its lines in \r\n, and may start with a byte order mark
  const lines = content
    .replace(/^﻿/, "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line === "") continue
    const lineNo = i + 1

    const eq = line.indexOf("=")
    const heredoc = line.indexOf("<<")
    const isHeredoc = heredoc !== -1 && (eq === -1 || heredoc < eq)
    if (!isHeredoc && eq === -1) {
      skip(lineNo, "expected NAME=value or NAME<<DELIMITER")
      continue
    }

    // Text that isn't NAME=value may be a secret written without its name, so
    // a message names the variable only once it is known to be one
    const name = line.slice(0, isHeredoc ? heredoc : eq)
    let value: string
    if (isHeredoc) {
      const delimiter = line.slice(heredoc + 2)
      if (delimiter === "") {
        skip(lineNo, "a NAME<< line has no delimiter")
        continue
      }
      const end = lines.indexOf(delimiter, i + 1)
      if (end === -1) {
        // An unclosed value runs to the end of the file, so nothing after it is a variable
        skip(
          lineNo,
          "a NAME<<DELIMITER value has no line that closes it",
          "It and the lines after it were ignored.",
        )
        break
      }
      value = lines.slice(i + 1, end).join("\n")
      i = end
    } else {
      value = line.slice(eq + 1)
    }

    if (!IDENT_RE.test(name)) {
      skip(
        lineNo,
        "the name is not a variable name. Use letters, digits and underscores, and don't start with a digit",
      )
    } else if (isRunbookEnvVar(name)) {
      skip(lineNo, `${name} is a variable Runbooks sets for every script`)
    } else if (isStartupEnvVar(name)) {
      skip(lineNo, `${name} makes programs run code as they start, so a script can't set it`)
    } else if (value.includes("\0")) {
      skip(lineNo, `${name}'s value has a NUL character, which no environment variable can hold`)
    } else {
      env.set(name, value)
    }
  }

  if (unreported > 0) {
    problems.push(`RUNBOOK_ENV: ${unreported} more lines were ignored.`)
  }
  return { env: Object.fromEntries(env), problems }
}

/**
 * Read and parse a RUNBOOK_ENV file (see parseRunbookEnvContent). A missing
 * file sets nothing: the script may have deleted it.
 */
export const parseRunbookEnv = (filePath: string): Effect.Effect<RunbookEnv, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const result = yield* fs.readFile(filePath).pipe(Effect.option)
    if (result._tag !== "Some") return { env: {}, problems: [] }
    return parseRunbookEnvContent(result.value)
  })

// ---------------------------------------------------------------------------
// Block Output Parsing
// ---------------------------------------------------------------------------

/**
 * A key prefix that marks an output as sensitive, e.g.
 * `sensitive:AWS_SECRET_ACCESS_KEY=...`. The prefix is not part of the key.
 * `:` can't appear in a valid key, so no existing output reads as marked.
 */
const SENSITIVE_OUTPUT_PREFIX = "sensitive:"

/**
 * Parse the contents of a RUNBOOK_OUTPUT file into key=value pairs. Pure, so
 * the test CLI shares this parser with the app.
 *
 * A key written as `sensitive:KEY` is stored as `KEY`, so templates and auth
 * blocks read it by its plain name, and its value is wrapped as a `Redacted`
 * (see outputValues.ts). Once any line marks a key, it stays sensitive even if
 * a later line rewrites it; the last value still wins.
 */
export function parseBlockOutputsContent(content: string): OutputValues {
  const values: Record<string, string> = {}
  const sensitiveKeys = new Set<string>()

  const lines = content.split("\n")
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === "") continue

    const eqIdx = line.indexOf("=")
    if (eqIdx === -1) {
      // Invalid output line (no = sign), skip
      continue
    }

    let key = line.slice(0, eqIdx).trim()
    const value = line.slice(eqIdx + 1) // Don't trim value - preserve whitespace

    const sensitive = key.startsWith(SENSITIVE_OUTPUT_PREFIX)
    if (sensitive) {
      key = key.slice(SENSITIVE_OUTPUT_PREFIX.length).trim()
    }

    if (!IDENT_RE.test(key)) {
      // Invalid output key, skip
      continue
    }

    values[key] = value
    if (sensitive) sensitiveKeys.add(key)
  }

  const outputs: OutputValues = {}
  for (const [key, value] of Object.entries(values)) {
    outputs[key] = sensitiveKeys.has(key) ? sensitiveOutput(value) : value
  }
  return outputs
}

/**
 * Read the RUNBOOK_OUTPUT file and parse key=value pairs.
 * Returns no outputs if the file is empty or missing.
 */
export const parseBlockOutputs = (
  filePath: string,
): Effect.Effect<OutputValues, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    const result = yield* fs.readFile(filePath).pipe(Effect.option)
    if (result._tag !== "Some") {
      return {}
    }

    return parseBlockOutputsContent(result.value)
  })

// ---------------------------------------------------------------------------
// File Capture
// ---------------------------------------------------------------------------

/**
 * Copy all files from the source directory (GENERATED_FILES temp dir) to the
 * output directory. Returns a list of captured files with relative paths and sizes.
 * Returns an empty array if the source directory is empty.
 */
export const captureFilesFromDir = (
  srcDir: string,
  outputDir: string,
): Effect.Effect<CapturedFile[], FileWriteError | FileReadError | FileNotFoundError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    // Check if source directory has any files
    const entries = yield* fs.readdir(srcDir)
    if (entries.length === 0) {
      return [] as CapturedFile[]
    }

    // Create the output directory if it doesn't exist
    yield* fs.mkdir(outputDir, { recursive: true })

    const capturedFiles: CapturedFile[] = []

    // Recursively walk using readdirWithTypes (avoids Stream complexity)
    const processDir = (
      dir: string,
      baseRelPath: string,
    ): Effect.Effect<void, FileWriteError | FileReadError | FileNotFoundError, FileSystem> =>
      Effect.gen(function* () {
        const dirEntries = yield* fs.readdirWithTypes(dir)
        for (const entry of dirEntries) {
          const fullPath = `${dir}/${entry.name}`
          const relPath = baseRelPath ? `${baseRelPath}/${entry.name}` : entry.name

          if (entry.isDirectory) {
            const dstPath = `${outputDir}/${relPath}`
            yield* fs.mkdir(dstPath, { recursive: true })
            yield* processDir(fullPath, relPath)
          } else if (entry.isFile) {
            const dstPath = `${outputDir}/${relPath}`
            // Ensure parent directory exists
            const parentDir = dstPath.slice(0, dstPath.lastIndexOf("/"))
            if (parentDir !== outputDir) {
              yield* fs.mkdir(parentDir, { recursive: true })
            }
            yield* fs.copyFile(fullPath, dstPath)

            const stat = yield* fs.stat(fullPath)
            capturedFiles.push({
              path: relPath.replace(/\\/g, "/"),
              size: stat.size,
            })
          }
        }
      })

    yield* processDir(srcDir, "")

    return capturedFiles
  })
