/**
 * The Terragrunt code a <TofuModule> block runs: the unit its module's
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
