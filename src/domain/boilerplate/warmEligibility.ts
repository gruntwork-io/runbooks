/**
 * Warm-render eligibility checks.
 *
 * The warm path renders from an in-memory bundle that holds only the files
 * under each template's own directory, and it can only address output paths
 * the analyzer resolved to a concrete relative file. Two things the cold
 * subprocess handles without trouble fall outside that:
 *
 *  - A `partials` entry that reaches above its template directory (the
 *    architecture catalog's `../../partials/*.hcl` convention). The bundle
 *    never captured that file, so every `{{ template "..." }}` using it fails
 *    in WASM with "template not defined".
 *  - An output path the analyzer could not resolve, such as a templated
 *    filename it collapsed to `.`. Asking the bridge to render it fails
 *    before the dynamic-filename routing gets a chance to send it cold.
 *
 * Both are bridge gaps, not template bugs, so the dispatcher must route
 * around them rather than surface them as render errors.
 */
import path from "node:path"
import YAML from "yaml"

const GLOB_CHARS = /[*?[\]{}]/

/**
 * Reports `partials` entries declared by bundled templates that the bundle
 * cannot resolve, as "<config path>: <entry>". An entry is unresolvable when
 * it escapes the bundle root, names a file that is not in the bundle, or is
 * a glob over a directory the bundle holds nothing under. A glob is not
 * matched file by file: the bundle captures every text file under a
 * template directory, so one file under the glob's directory is proof the
 * directory was captured.
 */
export function partialsOutsideBundle(files: Record<string, string>): string[] {
  const missing: string[] = []

  for (const [configPath, content] of Object.entries(files)) {
    if (!isBoilerplateConfig(configPath)) continue

    for (const entry of declaredPartials(content)) {
      const resolved = resolveWithinBundle(path.posix.dirname(configPath), entry)
      const present =
        resolved !== null &&
        (GLOB_CHARS.test(resolved)
          ? globDirectoryCaptured(files, resolved)
          : Object.hasOwn(files, resolved))

      if (!present) missing.push(`${configPath}: ${entry}`)
    }
  }

  return missing
}

/**
 * True when the bundle holds at least one file under the directory that
 * precedes the first glob segment. A glob at the bundle root is trusted,
 * since the root template's own files are always captured.
 */
function globDirectoryCaptured(files: Record<string, string>, resolvedGlob: string): boolean {
  const segments = resolvedGlob.split("/")
  const firstGlob = segments.findIndex((s) => GLOB_CHARS.test(s))
  const dir = segments.slice(0, firstGlob).join("/")

  if (dir === "") return true

  const prefix = `${dir}/`

  return Object.keys(files).some((f) => f.startsWith(prefix))
}

/**
 * True for an analyzer output path the WASM bridge can render. The analyzer
 * emits `.` for a file whose name is itself a template it could not resolve,
 * and a path still containing `{{` is one it did not render at all.
 */
export function isWarmRenderablePath(outputPath: string): boolean {
  const trimmed = outputPath.trim()

  return trimmed !== "" && trimmed !== "." && !trimmed.includes("{{")
}

function isBoilerplateConfig(bundlePath: string): boolean {
  return bundlePath === "boilerplate.yml" || bundlePath.endsWith("/boilerplate.yml")
}

/**
 * The bundle producer already validated every config, so a parse failure
 * here means nothing about partials and is treated as "none declared".
 */
function declaredPartials(content: string): string[] {
  let parsed: unknown

  try {
    parsed = YAML.parse(content)
  } catch {
    return []
  }

  const partials = (parsed as { partials?: unknown } | null)?.partials
  if (!Array.isArray(partials)) return []

  return partials.filter((p): p is string => typeof p === "string")
}

/**
 * Joins a partial entry onto its template directory, normalizing `.` and
 * `..` segments. Bundle paths use `/` on every OS, hence `path.posix`.
 * Returns null when the result leaves the bundle root, which is where every
 * out-of-tree partial ends up.
 */
function resolveWithinBundle(dir: string, entry: string): string | null {
  if (path.posix.isAbsolute(entry)) return null

  const joined = path.posix.join(dir, entry)

  return joined === ".." || joined.startsWith("../") ? null : joined
}
