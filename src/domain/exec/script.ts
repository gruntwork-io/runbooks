/**
 * Script preparation and environment capture.
 */
import { Effect, Scope } from "effect"
import { FileSystem } from "../../services/FileSystem.ts"
import type {
  FileWriteError,
  FileReadError,
  FileNotFoundError,
} from "../../errors/index.ts"
import type { CapturedFile } from "../../types.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Logging functions injected into every bash script wrapper.
 * Provides log_info, log_warn, log_error, log_debug.
 */
const LOGGING_FUNCTIONS = `
# --- Runbooks Logging Functions ---
# (auto-injected; see also scripts/logging.sh for local development)
_RUNBOOKS_LOGGING_LOADED=1

_log_timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log_info() {
    printf '[%s] [INFO]  %s\\n' "$(_log_timestamp)" "$*"
}

log_warn() {
    printf '[%s] [WARN]  %s\\n' "$(_log_timestamp)" "$*"
}

log_error() {
    printf '[%s] [ERROR] %s\\n' "$(_log_timestamp)" "$*"
}

log_debug() {
    if [ "\${DEBUG:-}" = "true" ]; then
        printf '[%s] [DEBUG] %s\\n' "$(_log_timestamp)" "$*"
    fi
}
# --- End Runbooks Logging Functions ---
`

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScriptSetup {
  readonly scriptPath: string
  readonly interpreter: string
  readonly args: readonly string[]
  readonly isBashScript: boolean
  readonly envCapturePath: string
  readonly pwdCapturePath: string
}

// ---------------------------------------------------------------------------
// Interpreter Detection
// ---------------------------------------------------------------------------

/**
 * Detect the interpreter from a shebang line or the provided language parameter.
 * Returns [interpreter, args].
 */
export function detectInterpreter(
  script: string,
  providedLang: string,
): [string, string[]] {
  // If language is explicitly provided, use it
  if (providedLang) {
    return [providedLang, []]
  }

  // Parse shebang line
  const lines = script.split("\n")
  if (lines.length > 0 && lines[0].startsWith("#!")) {
    const shebang = lines[0].slice(2).trim()

    // Handle #!/usr/bin/env <interpreter> [args...]
    if (shebang.includes("/env ")) {
      const parts = shebang.split(/\s+/)
      if (parts.length >= 2) {
        return [parts[1], parts.slice(2)]
      }
    } else {
      // Handle #!/bin/bash or #!/usr/bin/python3 etc.
      const parts = shebang.split(/\s+/)
      if (parts.length >= 1) {
        let interpreter = parts[0]
        const lastSlash = interpreter.lastIndexOf("/")
        if (lastSlash !== -1) {
          interpreter = interpreter.slice(lastSlash + 1)
        }
        return [interpreter, parts.slice(1)]
      }
    }
  }

  // Default to bash
  return ["bash", []]
}

/**
 * Returns true if the interpreter is a bash-compatible shell.
 */
export function isBashInterpreter(interpreter: string): boolean {
  switch (interpreter) {
    case "bash":
    case "sh":
    case "/bin/bash":
    case "/bin/sh":
    case "/usr/bin/bash":
    case "/usr/bin/sh":
      return true
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Bash Script Wrapping
// ---------------------------------------------------------------------------

/**
 * Wraps a user script with Runbooks infrastructure:
 *  1. Environment capture -- dumps env vars and pwd to temp files on exit
 *  2. Logging injection -- defines log_info, log_warn, log_error, log_debug
 *  3. EXIT trap interception -- chains user EXIT traps with our capture handler
 *
 * Uses `env -0` for NUL-terminated output to handle values with embedded newlines.
 */
export function wrapBashScript(
  script: string,
  envCapturePath: string,
  pwdCapturePath: string,
): string {
  return `#!/bin/bash
# =============================================================================
# Runbooks Bash Script Wrapper
# =============================================================================
# This wrapper injects logging functions and captures environment changes
# after the user script runs. It intercepts EXIT traps to ensure both user
# cleanup AND env capture run.
#
# Flow:
#   1. Define our capture function and trap override
#   2. Set our combined EXIT handler (using builtin to bypass override)
#   3. Inject logging functions (log_info, log_warn, log_error, log_debug)
#   4. Execute user script (which may call 'trap ... EXIT')
#   5. On exit: run user's handler first, then capture env
# =============================================================================

__RUNBOOKS_ENV_CAPTURE_PATH=${JSON.stringify(envCapturePath)}
__RUNBOOKS_PWD_CAPTURE_PATH=${JSON.stringify(pwdCapturePath)}

# -----------------------------------------------------------------------------
# Environment capture function
# Called on exit to dump env vars and working directory to temp files
# -----------------------------------------------------------------------------
__runbooks_capture_env() {
    # Use env -0 for NUL-terminated output to handle values with embedded newlines
    # (e.g., RSA keys, JSON, multiline strings)
    env -0 > "$__RUNBOOKS_ENV_CAPTURE_PATH" 2>/dev/null
    pwd > "$__RUNBOOKS_PWD_CAPTURE_PATH" 2>/dev/null
}

# -----------------------------------------------------------------------------
# Trap override mechanism
# -----------------------------------------------------------------------------
# In bash, only one handler can exist per signal. If the user script sets an
# EXIT trap, it would override ours and we'd lose env capture. To solve this,
# we define a function named 'trap' that shadows the builtin.
#
# When user calls: trap "rm -rf $TEMP_DIR" EXIT
# Our function:
#   1. Detects it's an EXIT trap
#   2. Saves the handler to __RUNBOOKS_USER_EXIT_HANDLER
#   3. Returns without setting the actual trap (ours remains active)
#
# For non-EXIT traps, we pass through to 'builtin trap' so they work normally.
# -----------------------------------------------------------------------------

# Store user's EXIT trap handler (if they set one)
__RUNBOOKS_USER_EXIT_HANDLER=""

# Override the trap builtin to intercept EXIT handlers
trap() {
    # Handle query flags (-p, -l) immediately - pass through to builtin
    if [[ "$1" == "-p" || "$1" == "-l" ]]; then
        builtin trap "$@"
        return $?
    fi

    # Check if EXIT (or signal 0, which is equivalent) is in the arguments
    local has_exit=false
    local i
    for i in "$@"; do
        if [[ "$i" == "EXIT" || "$i" == "0" ]]; then
            has_exit=true
            break
        fi
    done

    if $has_exit && [[ $# -ge 2 ]]; then
        # This is setting an EXIT trap - intercept it
        local handler="$1"
        if [[ "$handler" == "-" ]]; then
            # trap - EXIT: reset to default (clear user handler)
            __RUNBOOKS_USER_EXIT_HANDLER=""
        elif [[ -z "$handler" ]]; then
            # trap '' EXIT: ignore signal (clear user handler)
            __RUNBOOKS_USER_EXIT_HANDLER=""
        else
            # Save user's handler to call during exit
            __RUNBOOKS_USER_EXIT_HANDLER="$handler"
        fi
        return 0
    fi

    # Not an EXIT trap (or just querying) - pass through to builtin
    builtin trap "$@"
}

# -----------------------------------------------------------------------------
# Combined exit handler
# Runs when script exits to execute user cleanup AND capture environment
# -----------------------------------------------------------------------------
__runbooks_combined_exit() {
    local exit_code=$?

    # Run user's EXIT handler first (if any), so their cleanup happens
    if [[ -n "$__RUNBOOKS_USER_EXIT_HANDLER" ]]; then
        eval "$__RUNBOOKS_USER_EXIT_HANDLER" || true
    fi

    # Then capture environment (after user's changes but before exit)
    __runbooks_capture_env

    # Preserve the original exit code
    exit $exit_code
}

# Set our combined exit handler using 'builtin trap' to bypass our override
builtin trap __runbooks_combined_exit EXIT

# =============================================================================
# Logging Functions
# =============================================================================
${LOGGING_FUNCTIONS}
# =============================================================================
# USER SCRIPT BEGIN
# =============================================================================
${script}
# =============================================================================
# USER SCRIPT END
# =============================================================================
`
}

// ---------------------------------------------------------------------------
// Script Preparation (Effectful)
// ---------------------------------------------------------------------------

/**
 * Prepare a script for execution. Writes a temp file, detects the interpreter,
 * and optionally wraps bash scripts with env capture and logging injection.
 *
 * The returned ScriptSetup's temp files are cleaned up automatically via the
 * Effect Scope (addFinalizer).
 */
export const prepareScript = (
  content: string,
  language: string,
): Effect.Effect<
  ScriptSetup,
  FileWriteError,
  FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    const [interpreter, args] = detectInterpreter(content, language)
    const isBash = isBashInterpreter(interpreter)

    let scriptToWrite = content
    let envCapturePath = ""
    let pwdCapturePath = ""

    if (isBash) {
      // Create temp files for environment capture
      const envDir = yield* fs.mkdtemp("runbook-env-capture-")
      envCapturePath = `${envDir}/env.txt`
      yield* fs.writeFile(envCapturePath, "")

      const pwdDir = yield* fs.mkdtemp("runbook-pwd-capture-")
      pwdCapturePath = `${pwdDir}/pwd.txt`
      yield* fs.writeFile(pwdCapturePath, "")

      // Register cleanup for env/pwd capture temp dirs
      yield* Effect.addFinalizer(() =>
        Effect.all([
          fs.rm(envDir, { recursive: true, force: true }).pipe(Effect.ignore),
          fs.rm(pwdDir, { recursive: true, force: true }).pipe(Effect.ignore),
        ]).pipe(Effect.asVoid),
      )

      // Wrap the script with env capture and logging
      scriptToWrite = wrapBashScript(content, envCapturePath, pwdCapturePath)
    }

    // Write the script to a temp file
    const scriptDir = yield* fs.mkdtemp("runbook-script-")
    const scriptPath = `${scriptDir}/script.sh`
    yield* fs.writeFile(scriptPath, scriptToWrite)

    // Register cleanup for the script temp dir
    yield* Effect.addFinalizer(() =>
      fs.rm(scriptDir, { recursive: true, force: true }).pipe(Effect.ignore),
    )

    return {
      scriptPath,
      interpreter,
      args,
      isBashScript: isBash,
      envCapturePath,
      pwdCapturePath,
    } satisfies ScriptSetup
  })

// ---------------------------------------------------------------------------
// Environment Capture Parsing
// ---------------------------------------------------------------------------

/**
 * Check if a string is a valid environment variable name.
 * Must start with a letter or underscore, rest alphanumeric or underscore.
 */
function isValidEnvVarName(name: string): boolean {
  if (name.length === 0) return false
  const first = name[0]
  if (
    !(
      (first >= "A" && first <= "Z") ||
      (first >= "a" && first <= "z") ||
      first === "_"
    )
  ) {
    return false
  }
  for (let i = 1; i < name.length; i++) {
    const c = name[i]
    if (
      !(
        (c >= "A" && c <= "Z") ||
        (c >= "a" && c <= "z") ||
        (c >= "0" && c <= "9") ||
        c === "_"
      )
    ) {
      return false
    }
  }
  return true
}

/**
 * Parse the captured environment from temp files written by the bash wrapper.
 * The env file uses NUL-terminated entries (from `env -0`) to handle multiline values.
 * Falls back to newline-delimited parsing if no NUL characters found.
 *
 * Returns { env, pwd } where env may be undefined if the file was empty/missing.
 */
export const parseEnvCapture = (
  envCapturePath: string,
  pwdCapturePath: string,
): Effect.Effect<
  { env: Record<string, string> | undefined; pwd: string },
  never,
  FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    // Read environment capture
    let env: Record<string, string> | undefined = undefined
    const envResult = yield* fs
      .readFile(envCapturePath)
      .pipe(Effect.option)
    if (envResult._tag === "Some") {
      const data = envResult.value
      const parsed: Record<string, string> = {}

      if (data.includes("\0")) {
        // NUL-delimited: each entry is a complete KEY=VALUE pair
        for (const entry of data.split("\0")) {
          if (entry === "") continue
          const idx = entry.indexOf("=")
          if (idx !== -1) {
            parsed[entry.slice(0, idx)] = entry.slice(idx + 1)
          }
        }
      } else {
        // Newline-delimited fallback: handle multiline values by detecting
        // continuation lines (lines that don't start a new KEY=VALUE pair)
        let currentKey = ""
        let valueLines: string[] = []

        for (const line of data.split("\n")) {
          const idx = line.indexOf("=")
          if (idx > 0 && isValidEnvVarName(line.slice(0, idx))) {
            // Save previous key-value if any
            if (currentKey) {
              parsed[currentKey] = valueLines.join("\n")
            }
            currentKey = line.slice(0, idx)
            valueLines = [line.slice(idx + 1)]
          } else if (currentKey && line !== "") {
            valueLines.push(line)
          }
        }
        // Don't forget the last key
        if (currentKey) {
          parsed[currentKey] = valueLines.join("\n")
        }
      }

      if (Object.keys(parsed).length > 0) {
        env = parsed
      }
    }

    // Read working directory capture
    let pwd = ""
    const pwdResult = yield* fs
      .readFile(pwdCapturePath)
      .pipe(Effect.option)
    if (pwdResult._tag === "Some") {
      pwd = pwdResult.value.trim()
    }

    return { env, pwd }
  })

// ---------------------------------------------------------------------------
// Block Output Parsing
// ---------------------------------------------------------------------------

/**
 * Check if a key matches ^[a-zA-Z_][a-zA-Z0-9_]*$
 */
function isValidOutputKey(key: string): boolean {
  if (key.length === 0) return false
  const first = key[0]
  if (
    !(
      (first >= "a" && first <= "z") ||
      (first >= "A" && first <= "Z") ||
      first === "_"
    )
  ) {
    return false
  }
  for (let i = 1; i < key.length; i++) {
    const c = key[i]
    if (
      !(
        (c >= "a" && c <= "z") ||
        (c >= "A" && c <= "Z") ||
        (c >= "0" && c <= "9") ||
        c === "_"
      )
    ) {
      return false
    }
  }
  return true
}

/**
 * Read the RUNBOOK_OUTPUT file and parse key=value pairs.
 * Returns a map of outputs, or an empty record if the file is empty/missing.
 */
export const parseBlockOutputs = (
  filePath: string,
): Effect.Effect<
  Record<string, string>,
  never,
  FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const outputs: Record<string, string> = {}

    const result = yield* fs.readFile(filePath).pipe(Effect.option)
    if (result._tag !== "Some") {
      return outputs
    }

    const content = result.value
    const lines = content.split("\n")
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum].trim()
      if (line === "") continue

      const eqIdx = line.indexOf("=")
      if (eqIdx === -1) {
        // Invalid output line (no = sign), skip
        continue
      }

      const key = line.slice(0, eqIdx).trim()
      const value = line.slice(eqIdx + 1) // Don't trim value - preserve whitespace

      if (!isValidOutputKey(key)) {
        // Invalid output key, skip
        continue
      }

      outputs[key] = value
    }

    return outputs
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
): Effect.Effect<
  CapturedFile[],
  FileWriteError | FileReadError | FileNotFoundError,
  FileSystem
> =>
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
