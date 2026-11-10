/**
 * The Terragrunt code a <TfModule> block runs: the unit its module's
 * template renders, in a folder named for the block, beside a root.hcl.
 */

/** A file of the block's Terragrunt code, by its path in the workspace. */
export interface UnitFile {
  readonly path: string
  readonly content: string
}

/**
 * The root.hcl the unit's `include "root"` finds. It stands in for an
 * infrastructure repository's own root.hcl, and keeps state beside the unit,
 * so a later plan sees what an apply made.
 */
export const ROOT_HCL = `# Runbooks wrote this root.hcl so the unit beside it runs on its own.
# In an infrastructure repository, the unit includes that repository's root.hcl instead.
remote_state {
  backend  = "local"
  generate = { path = "backend.tf", if_exists = "overwrite" }
  config   = { path = "\${get_terragrunt_dir()}/terraform.tfstate" }
}
`

/** The unit's folder: the block's id, made safe as a folder name. */
export function unitFolder(blockId: string): string {
  return blockId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "_") || "_"
}

/**
 * A folder inside a repository: relative, with no part that climbs out of it.
 * Throws a message for the user when `given` isn't one.
 */
export function repoFolder(given: string): string {
  const normalized = given
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
  if (normalized.length === 0 || given.trim().startsWith("/")) {
    throw new Error(`"${given}" isn't a folder inside the repository.`)
  }
  if (normalized.includes("..")) {
    throw new Error(`"${given}" leaves the repository. Use a folder inside it.`)
  }
  return normalized.join("/")
}

/** The folders that hold `folder`, from the repository's root down, the root as "". */
export function ancestorsOf(folder: string): string[] {
  const parts = folder.split("/")
  return parts.map((_, i) => parts.slice(0, i).join("/"))
}

/**
 * How a file shown with the unit relates to the repository: the unit adds it,
 * or changes it, or leaves it as it is; a context file is one already there
 * in a folder above the unit, such as the root.hcl the unit includes.
 */
export type RepoFileStatus = "added" | "modified" | "unchanged" | "context"

export interface RepoFile extends UnitFile {
  /** By its path from the repository's root. */
  readonly path: string
  readonly status: RepoFileStatus
  /** What the repository holds now, for a modified file. */
  readonly before?: string
}

/** Text as git keeps it, whatever its line endings and final newlines. */
const asStored = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n*$/, "")

/** Whether a file is Terragrunt configuration a unit below it may include. */
const isContext = (name: string) => name.endsWith(".hcl")

/**
 * The unit as it lands in a repository: its rendered files in `folder`, each
 * marked against what the repository holds there, and the Terragrunt files in
 * the folders above it, which it may include. `existing` maps paths from the
 * repository's root to their content, for the unit's folder and those above it.
 */
export function placeUnit(
  folder: string,
  rendered: readonly UnitFile[],
  existing: ReadonlyMap<string, string>,
): RepoFile[] {
  const unit = rendered.map((file): RepoFile => {
    const path = `${folder}/${file.path}`
    const before = existing.get(path)
    if (before === undefined) return { path, content: file.content, status: "added" }
    if (asStored(before) === asStored(file.content)) {
      return { path, content: file.content, status: "unchanged" }
    }
    return { path, content: file.content, status: "modified", before }
  })
  const above = new Set(ancestorsOf(folder))
  const context = [...existing]
    .filter(([path]) => {
      const slash = path.lastIndexOf("/")
      return above.has(slash === -1 ? "" : path.slice(0, slash)) && isContext(path.slice(slash + 1))
    })
    .map(([path, content]): RepoFile => ({ path, content, status: "context" }))
  return [...context, ...unit].sort((a, b) => a.path.localeCompare(b.path))
}

/** Whether the repository has a root.hcl in a folder above the unit, for its `include "root"`. */
export function hasRootHcl(files: readonly RepoFile[]): boolean {
  return files.some(
    (file) =>
      file.status === "context" && (file.path === "root.hcl" || file.path.endsWith("/root.hcl")),
  )
}
