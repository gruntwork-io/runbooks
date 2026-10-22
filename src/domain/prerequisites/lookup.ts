/**
 * How a <Prerequisites> check asks bash where its tools are, and runs them to
 * read their versions. The main process and the test CLI run these the same
 * way, with the session's env and working directory, so a tool counts as
 * installed exactly when a script could run it.
 *
 * Going through bash rather than searching PATH here means bash's rules
 * apply: on Windows, for one, Git Bash finds `tofu.exe` for `tofu` and turns
 * PATH into its own form. Only executable files on PATH count. A function or
 * alias from an rc file doesn't: a script can't use it either.
 */

/**
 * Prints "<name>\t<path>" for each tool name given, with an empty path for one
 * that isn't on PATH. `type -P` skips builtins, functions and aliases, and
 * finds an executable file before one that isn't; the `-x` test drops a file
 * it found that isn't, which would only fail with "Permission denied".
 */
export const LOOKUP_SCRIPT =
  'for t; do p=$(type -P -- "$t"); [ -f "$p" ] && [ -x "$p" ] || p=; printf "%s\\t%s\\n" "$t" "$p"; done'

/**
 * Runs its arguments with stderr merged into stdout, since some tools, such as
 * `java -version`, print their version to stderr.
 */
export const PROBE_SCRIPT = '"$@" 2>&1'

/** How long bash gets to look for the tools. */
export const LOOKUP_TIMEOUT_MS = 10_000

/** How long a tool gets to print its version. */
export const PROBE_TIMEOUT_MS = 15_000

/** The arguments to `bash` that look for `names` on PATH. */
export function lookupArgs(names: readonly string[]): string[] {
  return ["-c", LOOKUP_SCRIPT, "runbooks", ...names]
}

/** The arguments to `bash` that run the tool at `path` with `versionArgs`. */
export function probeArgs(path: string, versionArgs: readonly string[]): string[] {
  return ["-c", PROBE_SCRIPT, "runbooks", path, ...versionArgs]
}

/** Each looked-up tool's path, from the lookup's output lines. A tool that isn't on PATH has none. */
export function parseLookupOutput(lines: readonly string[]): Map<string, string> {
  const paths = new Map<string, string>()
  for (const line of lines) {
    const tab = line.indexOf("\t")
    if (tab <= 0) continue
    const path = line.slice(tab + 1).trim()
    if (path) paths.set(line.slice(0, tab), path)
  }
  return paths
}
