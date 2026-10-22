/**
 * Populate process.env with the user's shell environment.
 *
 * When the Electron app is launched from Finder or the dock (macOS) or a
 * desktop entry (Linux), it inherits the minimal GUI launchd environment
 * rather than the user's shell env. That means PATH only contains system
 * paths like /usr/bin:/bin, so tools installed via Homebrew, mise, asdf,
 * nvm, etc. are invisible to scripts we spawn.
 *
 * We fix this by spawning the user's login+interactive shell once at
 * startup and dumping its environment, then merging it into process.env.
 * Any session we later create via SessionManager will capture this richer
 * environment and pass it to user scripts.
 *
 * No-op on Windows and when we were launched from a terminal (the user's
 * env is already inherited in that case).
 *
 * readLoginShellPath reads the login shell's PATH again later, for a
 * <Prerequisites> block that can't find a tool installed since.
 */

import { spawn, spawnSync } from "node:child_process"
import { makeLogger } from "./logger.ts"

const log = makeLogger("shell-env")

/** Keys we never overwrite — these are managed by the Electron/Node runtime. */
const PROTECTED_KEYS = new Set<string>(["PWD", "OLDPWD", "SHLVL", "_"])

/** Marker used to locate the start of the env dump amid any rc-file noise. */
const MARKER = "__RUNBOOKS_SHELL_ENV_MARKER__"

// Print a known marker followed by env(1) output. The marker lets us skip any
// stdout that rc files may have produced (common with Powerlevel10k instant
// prompt, motd, etc.). `env -0` is NUL-delimited so multiline values (RSA
// keys, JSON, etc.) round-trip safely.
const ENV_DUMP_SCRIPT = `printf '%s\\0' '${MARKER}'; env -0`

/**
 * How long readLoginShellPath gives the login shell: longer than at startup,
 * where it holds up the app's window.
 */
const READ_PATH_TIMEOUT_MS = 10_000

/** How long readLoginShellPath waits for the shell's output after the shell exits. */
const EXIT_GRACE_MS = 500

/**
 * Whether the app was launched from a terminal, whose env it has inherited.
 * Every terminal emulator (and ssh session) sets TERM; GUI launches via
 * launchd (macOS) or a display manager's desktop session (Linux) do not.
 *
 * TERM=linux is the exception. It is the Linux virtual console's value, and
 * no Electron window opens on a bare console, so seeing it means a desktop
 * session started from a TTY login (startx, `exec sway` in ~/.zprofile)
 * handed it down to the apps its launcher starts. That login shell may have
 * exec'd the desktop before reading ~/.zshrc or ~/.bashrc, so the capture
 * still has to run.
 *
 * TERM_PROGRAM stays in the check: the e2e suite sets it
 * (electron/e2e/vcs-auth.spec.ts) to skip this capture.
 */
export function isTerminalLaunch(env: NodeJS.ProcessEnv): boolean {
  const term = env.TERM === "linux" ? undefined : env.TERM
  return Boolean(term || env.TERM_PROGRAM || env.ITERM_SESSION_ID)
}

/**
 * Parse the login shell's output: rc-file noise, then the marker, then the
 * NUL-delimited `env -0` dump. Returns [] when the marker is missing. Values
 * may contain '=' and newlines; entries without '=' are skipped.
 */
export function parseEnvDump(stdout: string): Array<[string, string]> {
  const markerIdx = stdout.indexOf(MARKER)
  if (markerIdx === -1) return []

  // Skip the marker and the NUL separator that printf emitted after it.
  const envText = stdout.slice(markerIdx + MARKER.length + 1)

  const entries: Array<[string, string]> = []
  for (const entry of envText.split("\0")) {
    if (entry === "") continue
    const eq = entry.indexOf("=")
    if (eq === -1) continue
    entries.push([entry.slice(0, eq), entry.slice(eq + 1)])
  }
  return entries
}

export function populateShellEnv(): void {
  if (process.platform === "win32") return

  // If the app was launched from a terminal, the user's env is already
  // inherited: spawning a login shell would be wasted work, and merging its
  // output would clobber values set for this launch (GITLAB_HOST=… runbooks).
  if (isTerminalLaunch(process.env)) {
    log.debug("Already running from a terminal; skipping shell env capture")
    return
  }

  const shell = process.env.SHELL
  if (!shell) {
    log.warn("SHELL is not set; cannot capture user shell environment")
    return
  }

  let result
  try {
    result = spawnSync(shell, ["-ilc", ENV_DUMP_SCRIPT], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    })
  } catch (err) {
    log.warn("Failed to spawn login shell to capture env:", err)
    return
  }

  if (result.error) {
    log.warn("Login shell exited with error:", result.error)
    return
  }

  const stdout = result.stdout ?? ""
  if (!stdout.includes(MARKER)) {
    log.warn("Could not locate marker in shell env output")
    return
  }
  const entries = parseEnvDump(stdout)
  if (entries.length === 0) {
    log.warn("Shell env output had the marker but no env entries (env -0 failed?)")
    return
  }

  let count = 0
  for (const [key, value] of entries) {
    if (PROTECTED_KEYS.has(key)) continue
    process.env[key] = value
    count++
  }

  log.info(`Populated process.env from ${shell} (${count} vars)`)
}

/**
 * The PATH of the user's login shell, read as populateShellEnv reads its env
 * but without blocking the main process, and whether or not the app was
 * launched from a terminal: a terminal's env is as old as the terminal, and
 * misses what an installer has added to an rc file since.
 *
 * Rejects, with a message fit to show the user, on Windows (whose PATH is in
 * the registry, which this doesn't read), and when the shell can't be run or
 * prints no PATH.
 */
export async function readLoginShellPath(): Promise<{ shell: string; path: string }> {
  if (process.platform === "win32") {
    throw new Error(
      "Runbooks can't read PATH again on Windows yet. Restart Runbooks to pick up a changed PATH.",
    )
  }
  const shell = process.env.SHELL
  if (!shell) {
    throw new Error("SHELL isn't set, so there's no login shell to read PATH from.")
  }

  const stdout = await runLoginShell(shell)
  const path = new Map(parseEnvDump(stdout)).get("PATH")
  if (!path) {
    throw new Error(`${shell} printed no PATH.`)
  }
  return { shell, path }
}

/**
 * What the login shell printed for ENV_DUMP_SCRIPT. Its stdin is empty, so an
 * rc file that reads it can't hang.
 */
function runLoginShell(shell: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-ilc", ENV_DUMP_SCRIPT], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
    let stdout = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })

    const timers: NodeJS.Timeout[] = []
    const settle = (settleWith: () => void) => {
      for (const timer of timers) clearTimeout(timer)
      settleWith()
    }
    timers.push(
      setTimeout(() => {
        child.kill()
        settle(() =>
          reject(
            new Error(`${shell} didn't finish within ${READ_PATH_TIMEOUT_MS / 1000} seconds.`),
          ),
        )
      }, READ_PATH_TIMEOUT_MS),
    )
    child.on("error", (err) => {
      settle(() => reject(new Error(`Couldn't run ${shell}: ${err.message}`, { cause: err })))
    })
    child.on("close", () => settle(() => resolve(stdout)))
    // Something an rc file started in the background (an ssh-agent, say) can
    // hold stdout open after the shell exits, which would hold off "close".
    // Everything the shell printed has arrived soon after it exits.
    child.on("exit", () => {
      timers.push(setTimeout(() => settle(() => resolve(stdout)), EXIT_GRACE_MS))
    })
  })
}
