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
 * No-op on Windows and when we already appear to be launched from a
 * terminal (the user's env is already inherited in that case).
 */

import { spawnSync } from "node:child_process"
import { makeLogger } from "./logger.ts"

const log = makeLogger("shell-env")

/** Keys we never overwrite — these are managed by the Electron/Node runtime. */
const PROTECTED_KEYS = new Set<string>([
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
])

/** Marker used to locate the start of the env dump amid any rc-file noise. */
const MARKER = "__RUNBOOKS_SHELL_ENV_MARKER__"

export function populateShellEnv(): void {
  if (process.platform === "win32") return

  // If the app was launched from a terminal, the user's env is already
  // inherited and spawning a login shell would be wasted work.
  if (process.env.TERM_PROGRAM || process.env.ITERM_SESSION_ID) {
    log.debug("Already running from a terminal; skipping shell env capture")
    return
  }

  const shell = process.env.SHELL
  if (!shell) {
    log.warn("SHELL is not set; cannot capture user shell environment")
    return
  }

  // Print a known marker followed by env(1) output. The marker lets us
  // skip any stdout that rc files may have produced (common with
  // Powerlevel10k instant prompt, motd, etc.). `env -0` is NUL-delimited
  // so multiline values (RSA keys, JSON, etc.) round-trip safely.
  const script = `printf '%s\\0' '${MARKER}'; env -0`

  let result
  try {
    result = spawnSync(shell, ["-ilc", script], {
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
  const markerIdx = stdout.indexOf(MARKER)
  if (markerIdx === -1) {
    log.warn("Could not locate marker in shell env output")
    return
  }

  // Skip the marker and the NUL separator that printf emitted after it.
  const envText = stdout.slice(markerIdx + MARKER.length + 1)

  let count = 0
  for (const entry of envText.split("\0")) {
    if (entry === "") continue
    const eq = entry.indexOf("=")
    if (eq === -1) continue
    const key = entry.slice(0, eq)
    if (PROTECTED_KEYS.has(key)) continue
    const value = entry.slice(eq + 1)
    process.env[key] = value
    count++
  }

  log.info(`Populated process.env from ${shell} (${count} vars)`)
}
