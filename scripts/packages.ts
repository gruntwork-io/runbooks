/**
 * The new tree's packages: where each lives and which packages it may import.
 *
 * A package is a TypeScript project, not a bun workspace. Its `tsconfig.json`
 * extends `tsconfig.packages.json` and references the packages it imports;
 * `tsconfig.packages.json` maps each package's exports to files with `paths`.
 * An import of a package the importer does not reference fails the compile
 * (TS6307), and so does a subpath the package does not export (TS2307).
 * Bun workspaces would link every package into node_modules, where any import
 * resolves.
 *
 * `packages.test.ts` checks each package's references against `mayImport`.
 * A package's folder and tsconfig.json are created with its first code.
 */

export interface Package {
  readonly dir: string
  readonly mayImport: ReadonlyArray<PackageName>
}

export type PackageName =
  | "blocks-core"
  | "core"
  | "blocks"
  | "platform-node"
  | "app-main"
  | "app-renderer"
  | "cli"

export const PACKAGES: Record<PackageName, Package> = {
  /** The block contract, status and form types. Imports only effect. */
  "blocks-core": { dir: "blocks/core", mayImport: [] },
  /** Document, parser, engine, protocol, service interfaces, domain code. */
  core: { dir: "packages/core", mayImport: ["blocks-core"] },
  /** One folder per block, the registry and the view map. */
  blocks: { dir: "blocks", mayImport: ["blocks-core", "core"] },
  /** The layers: the only Node I/O and SDK imports. */
  "platform-node": { dir: "packages/platform-node", mayImport: ["blocks-core", "core"] },
  /** Electron main: the IPC transport. */
  "app-main": {
    dir: "packages/app-main",
    mayImport: ["blocks-core", "core", "platform-node", "blocks"],
  },
  /** The window. It reads the core's protocol only. */
  "app-renderer": { dir: "packages/app-renderer", mayImport: ["blocks-core", "core", "blocks"] },
  /** The `runbooks` command: open, test, validate, mcp. */
  cli: { dir: "packages/cli", mayImport: ["blocks-core", "core", "platform-node", "blocks"] },
}

/** The package `file` (relative to the repo root) belongs to: the one with the deepest folder holding it. */
export function packageOf(file: string): PackageName | undefined {
  let found: PackageName | undefined
  for (const [name, { dir }] of Object.entries(PACKAGES) as [PackageName, Package][]) {
    if (!file.startsWith(`${dir}/`)) continue
    if (found === undefined || dir.length > PACKAGES[found].dir.length) found = name
  }
  return found
}
