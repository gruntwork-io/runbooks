/**
 * The modules a file loads when it runs, followed through relative imports
 * and the packages' aliases (`tsconfig.packages.json` `paths`).
 *
 * Bun's transpiler reads each file's imports: static imports and
 * re-exports, `import()` of a string and `require`, and not type-only
 * imports, which load nothing. An `import()` of anything but a string is
 * not followed: no-computed-import keeps those out of the core and the
 * blocks.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

/** A file or module the entry loads, and a shortest path of imports to it. */
export interface Loaded {
  /** A file's path from the root, or a module's name as it is imported. */
  readonly name: string
  /** The files from the entry to the one that imports this, from the root. */
  readonly via: ReadonlyArray<string>
}

export interface ImportGraph {
  /** Every file in the tree the entry loads, the entry first. */
  readonly files: ReadonlyArray<Loaded>
  /** Every module from outside the tree it loads, once each: an npm package, or a Node or Bun built-in. */
  readonly modules: ReadonlyArray<Loaded>
}

type Paths = Readonly<Record<string, ReadonlyArray<string>>>

/** The aliases `tsconfig.packages.json` under `root` maps to files. */
function pathsOf(root: string): Paths {
  const config = Bun.JSONC.parse(
    readFileSync(path.join(root, "tsconfig.packages.json"), "utf8"),
  ) as {
    readonly compilerOptions?: { readonly paths?: Paths }
  }
  return config.compilerOptions?.paths ?? {}
}

/** The file an alias names, as the compiler maps it: an exact key, else the longest `prefix*` key. */
function resolveAlias(root: string, paths: Paths, spec: string): string | undefined {
  const exact = paths[spec]?.[0]
  if (exact !== undefined) return path.join(root, exact)
  let found: { readonly prefix: string; readonly target: string } | undefined
  for (const [key, [target]] of Object.entries(paths)) {
    if (!key.endsWith("*") || target === undefined) continue
    const prefix = key.slice(0, -1)
    if (spec.startsWith(prefix) && (found === undefined || prefix.length > found.prefix.length)) {
      found = { prefix, target }
    }
  }
  return found && path.join(root, found.target.replace("*", spec.slice(found.prefix.length)))
}

const LOADERS = { ".ts": "ts", ".tsx": "tsx", ".js": "js" } as const

/** What `file` imports at run time. */
function importsOf(file: string): ReadonlyArray<string> {
  const loader = LOADERS[path.extname(file) as keyof typeof LOADERS] ?? "ts"
  const text = readFileSync(file, "utf8")
  return new Bun.Transpiler({ loader }).scanImports(text).map((found) => found.path)
}

/** The import graph of `entry`, a file under `root`, given from the root or absolute. */
export function importGraph(root: string, entry: string): ImportGraph {
  const paths = pathsOf(root)
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/")
  const start = path.resolve(root, entry)
  const via = new Map<string, ReadonlyArray<string>>([[start, []]])
  const modules = new Map<string, Loaded>()
  // Breadth first, so the path kept to each file and module is a shortest one.
  for (const file of via.keys()) {
    const chain = [...(via.get(file) ?? []), relative(file)]
    for (const spec of importsOf(file)) {
      const target =
        spec.startsWith("./") || spec.startsWith("../")
          ? path.resolve(path.dirname(file), spec)
          : resolveAlias(root, paths, spec)
      if (target === undefined) {
        if (!modules.has(spec)) modules.set(spec, { name: spec, via: chain })
      } else if (!via.has(target)) {
        via.set(target, chain)
      }
    }
  }
  const files = [...via].map(([file, chain]) => ({ name: relative(file), via: chain }))
  return { files, modules: [...modules.values()] }
}
