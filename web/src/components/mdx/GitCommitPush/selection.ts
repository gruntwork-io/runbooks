import type { WorkspaceFileChange } from "@/contexts/WorkspaceGitDataContext.types"

/**
 * Whether a changed file's path matches one of `selectedPaths`. A pattern is
 * a repo-relative path, where `*` stands for any part of one folder or file
 * name and `**` for any number of folders. A pattern naming a folder matches
 * every file under it.
 */
export function matchesSelectedPath(pattern: string, path: string): boolean {
  const cleaned = pattern.trim().replace(/^\.\//, "").replace(/\/+$/, "")
  if (cleaned === "") return false
  const file = path.replace(/\/+$/, "")
  return patternRegExp(cleaned).test(file)
}

function patternRegExp(pattern: string): RegExp {
  let source = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === "*" && pattern[i + 1] === "*") {
      // `**/` is any number of folders, none included; a final `**` is anything.
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?"
        i += 2
      } else {
        source += ".*"
        i += 1
      }
    } else if (char === "*") {
      source += "[^/]*"
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    }
  }
  // The pattern names the file itself, or a folder the file is in.
  return new RegExp(`^${source}(?:/.*)?$`)
}

/** Whether a file starts chosen: every file without `selectedPaths`, else the ones they match. */
export function startsSelected(
  selectedPaths: readonly string[] | undefined,
  path: string,
): boolean {
  return selectedPaths === undefined || selectedPaths.some((p) => matchesSelectedPath(p, path))
}

const VERBS: Record<WorkspaceFileChange["changeType"], string> = {
  added: "Add",
  modified: "Update",
  deleted: "Delete",
}

/**
 * A commit message that says what the chosen files are: one file by its path
 * and change, several by how many and the folder they share.
 */
export function suggestCommitMessage(chosen: readonly WorkspaceFileChange[]): string {
  const [first] = chosen
  if (first === undefined) return ""
  if (chosen.length === 1) return `${VERBS[first.changeType]} ${first.path}`
  const kinds = new Set(chosen.map((c) => c.changeType))
  const verb = kinds.size === 1 ? VERBS[first.changeType] : "Update"
  const folder = sharedFolder(chosen.map((c) => c.path))
  return `${verb} ${chosen.length} files${folder ? ` in ${folder}` : ""}`
}

/** The deepest folder every path is in, or "" when they share none. */
function sharedFolder(paths: readonly string[]): string {
  const folders = paths.map((p) => p.replace(/\/+$/, "").split("/").slice(0, -1))
  const [first = []] = folders
  let depth = 0
  while (depth < first.length && folders.every((f) => f[depth] === first[depth])) depth++
  return first.slice(0, depth).join("/")
}
