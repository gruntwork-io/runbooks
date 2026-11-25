/**
 * The new tree's own lint rules, loaded by oxlint as a JS plugin
 * (.oxlintrc.json `jsPlugins`). Each takes an optional `{ root }`, the folder
 * holding the packages, which is this repository unless a test lints a
 * folder of its own.
 *
 * no-relative-import-across-packages: a relative import may not cross a
 * package boundary in either direction. The compiler already refuses a
 * package the importer does not reference; this closes the gap it leaves, a
 * relative path into a referenced package's files that it does not export.
 * Packages import each other by name: `@runbooks/<package>/<export>`.
 *
 * no-import-between-blocks: a block's folder imports no other block's folder,
 * and not the registry, which imports every block.
 *
 * no-react-in-block-ts: a block's `block.ts` imports no React and no `.tsx`
 * file, so the engine and the CLI load it without a view. The `blocks/**`
 * override already keeps Electron, Node I/O and SDKs out of every block file.
 *
 * block-name-outside-its-folder: no file in the packages names a block
 * outside the block's folder and its lines in the registry files, so adding
 * or removing a block touches one folder and those lines. The blocks are the
 * tags in `blocks/index.ts` and the frozen baseline's blocks
 * (`baseline/props.json`), which the rebuild carries. Code names a block
 * when a string is its tag or holds `<Tag`, or a key, JSX element or export
 * is named for it. Comments and prose are not checked: "Check" and "Template"
 * are words too.
 */
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { packageOf } from "./packages.ts"

const REPO = path.resolve(import.meta.dirname, "..")

/** The registry: one line per block or alias. */
const REGISTRY = "blocks/index.ts"
/** The files a block adds its lines to. */
const REGISTRY_FILES: ReadonlySet<string> = new Set([REGISTRY, "blocks/views.ts"])
/** The blocks the frozen baseline holds, by tag. */
const BASELINE_BLOCKS = "baseline/props.json"

/** One registry line, `export { command as Command } from "./command/block.ts"`. */
const REGISTRY_LINE = /^export \{ (\w+) as (\w+) \} from "\.\/([\w-]+)\/[\w./-]+"$/

interface Position {
  readonly line: number
}

interface Node {
  readonly type: string
  readonly loc: { readonly start: Position }
  readonly source?: { readonly type: string; readonly value: unknown } | null
  readonly value?: unknown
  readonly name?: string
  readonly computed?: boolean
  readonly key?: Node
  readonly exported?: Node
  readonly specifiers?: ReadonlyArray<Node>
  readonly declaration?: Node | null
  readonly body?: ReadonlyArray<Node>
}

interface Context {
  readonly filename: string
  readonly options: ReadonlyArray<{ readonly root?: string } | undefined>
  readonly sourceCode: { readonly lines: ReadonlyArray<string> }
  report(problem: { node: unknown; messageId: string; data?: Record<string, string> }): void
}

const ROOT_OPTION = [
  {
    type: "object",
    properties: { root: { type: "string" } },
    additionalProperties: false,
  },
]

/** The linted file, relative to the root, with `/` separators. */
function fileOf(context: Context): { readonly root: string; readonly file: string } {
  const root = context.options[0]?.root ?? REPO
  return { root, file: path.relative(root, context.filename).split(path.sep).join("/") }
}

/** Where a relative import points, relative to the root. */
function target(root: string, filename: string, spec: string): string {
  return path
    .relative(root, path.resolve(path.dirname(filename), spec))
    .split(path.sep)
    .join("/")
}

/** Each kind of node that imports or re-exports a module, checked by `check`. */
function imports(check: (node: Node) => void) {
  return {
    ImportDeclaration: check,
    ExportAllDeclaration: check,
    ExportNamedDeclaration: check,
    ImportExpression: check,
  }
}

/** The module a node imports, when it is written as a string. */
function specOf(node: Node): string | undefined {
  const source = node.source
  return source?.type === "Literal" && typeof source.value === "string" ? source.value : undefined
}

const where = (name: string | undefined) => name ?? "outside the packages"

const noRelativeImportAcrossPackages = {
  meta: {
    type: "problem",
    docs: { description: "A relative import may not cross a package boundary" },
    messages: {
      crosses:
        "{{spec}} crosses from {{from}} into {{to}}. Import a package by name, as @runbooks/<package>/<export>, from a package that references it.",
    },
    schema: ROOT_OPTION,
  },
  create(context: Context) {
    const { root, file } = fileOf(context)
    const from = packageOf(file)
    return imports((node) => {
      const spec = specOf(node)
      if (spec === undefined || (!spec.startsWith("./") && !spec.startsWith("../"))) return
      const to = packageOf(target(root, context.filename, spec))
      if (to === from) return
      context.report({
        node: node.source,
        messageId: "crosses",
        data: { spec, from: where(from), to: where(to) },
      })
    })
  },
}

/** The block folder `file` is in: `command` for `blocks/command/block.ts`. */
function blockFolderOf(file: string): string | undefined {
  if (packageOf(file) !== "blocks") return undefined
  const [, folder, ...rest] = file.split("/")
  return rest.length > 0 ? folder : undefined
}

const noImportBetweenBlocks = {
  meta: {
    type: "problem",
    docs: { description: "A block's folder may not import another block's folder or the registry" },
    messages: {
      between:
        "{{spec}} reaches from blocks/{{from}}/ into {{to}}. A block imports no other block: code two blocks need moves to blocks/core or a service.",
    },
    schema: ROOT_OPTION,
  },
  create(context: Context) {
    const { root, file } = fileOf(context)
    const from = blockFolderOf(file)
    if (from === undefined) return {}
    return imports((node) => {
      const spec = specOf(node)
      if (spec === undefined) return
      let to: string | undefined
      if (spec === "@runbooks/blocks" || spec.startsWith("@runbooks/blocks/")) {
        to = "the registry"
      } else if (spec.startsWith("./") || spec.startsWith("../")) {
        const resolved = target(root, context.filename, spec)
        // Into blocks/core, another package, the first rule reports.
        if (packageOf(resolved) !== "blocks" || blockFolderOf(resolved) === from) return
        const folder = blockFolderOf(resolved)
        to = folder === undefined ? resolved : `blocks/${folder}/`
      }
      if (to === undefined) return
      context.report({ node: node.source, messageId: "between", data: { spec, from, to } })
    })
  },
}

const REACT = /^react(-dom)?(\/|$)/

const noReactInBlockTs = {
  meta: {
    type: "problem",
    docs: { description: "A block's block.ts may not import React or a view" },
    messages: {
      react:
        "block.ts imports {{spec}}. The engine and the CLI load block.ts, so it imports no React: the view goes in View.tsx and a line in blocks/views.ts.",
    },
    schema: ROOT_OPTION,
  },
  create(context: Context) {
    const { file } = fileOf(context)
    const folder = blockFolderOf(file)
    if (folder === undefined || file !== `blocks/${folder}/block.ts`) return {}
    return imports((node) => {
      const spec = specOf(node)
      if (spec === undefined || !(REACT.test(spec) || spec.endsWith(".tsx"))) return
      context.report({ node: node.source, messageId: "react", data: { spec } })
    })
  },
}

/** Each block's tag, with the folder its registry line names, or none while it has no line. */
interface Blocks {
  readonly folders: ReadonlyMap<string, string | undefined>
  /** `<Tag`, for any tag, where it ends. */
  readonly tagInText: RegExp | undefined
}

const blocksByRoot = new Map<string, Blocks>()

/** The blocks under `root`: the registry's tags, then the baseline's. Read once per root. */
function blocksOf(root: string): Blocks {
  const known = blocksByRoot.get(root)
  if (known !== undefined) return known
  const folders = new Map<string, string | undefined>()
  const registry = path.join(root, REGISTRY)
  if (existsSync(registry)) {
    for (const line of readFileSync(registry, "utf8").split("\n")) {
      const [, , tag, folder] = REGISTRY_LINE.exec(line) ?? []
      if (tag !== undefined && folder !== undefined) folders.set(tag, folder)
    }
  }
  const baseline = path.join(root, BASELINE_BLOCKS)
  if (existsSync(baseline)) {
    const tags = Object.keys(JSON.parse(readFileSync(baseline, "utf8")) as Record<string, unknown>)
    for (const tag of tags) if (!folders.has(tag)) folders.set(tag, undefined)
  }
  const tags = [...folders.keys()]
  const blocks: Blocks = {
    folders,
    tagInText: tags.length > 0 ? new RegExp(`<(${tags.join("|")})(?!\\w)`, "g") : undefined,
  }
  blocksByRoot.set(root, blocks)
  return blocks
}

const blockNameOutsideItsFolder = {
  meta: {
    type: "problem",
    docs: {
      description: "Only a block's folder and its registry lines may name the block",
    },
    messages: {
      named:
        "{{tag}} is the block in blocks/{{folder}}/. Only that folder and its lines in blocks/index.ts and blocks/views.ts may name it: elsewhere, ask the registry, or key on a class or capability.",
      unregistered:
        "{{tag}} is a block the rebuild carries ({{baseline}}). Only its folder and its registry lines may name it: elsewhere, ask the registry, or key on a class or capability.",
      notALine:
        'blocks/index.ts holds one line per block or alias, `export { command as Command } from "./command/block.ts"`, and nothing else.',
    },
    schema: ROOT_OPTION,
  },
  create(context: Context) {
    const { root, file } = fileOf(context)
    if (packageOf(file) === undefined) return {}
    const { folders, tagInText } = blocksOf(root)
    const inFolder = blockFolderOf(file)

    const allowed = (tag: string, node: Node): boolean => {
      const folder = folders.get(tag)
      if (folder === undefined) return false
      if (inFolder === folder) return true
      // A registry line names the block and its folder.
      const line = context.sourceCode.lines[node.loc.start.line - 1] ?? ""
      return REGISTRY_FILES.has(file) && line.includes(`"./${folder}/`)
    }
    const report = (tag: string, node: Node) => {
      if (allowed(tag, node)) return
      const folder = folders.get(tag)
      context.report(
        folder === undefined
          ? { node, messageId: "unregistered", data: { tag, baseline: BASELINE_BLOCKS } }
          : { node, messageId: "named", data: { tag, folder } },
      )
    }
    /** A key, element or export name that is a tag. */
    const name = (node: Node | undefined) => {
      if (node?.type === "Identifier" || node?.type === "JSXIdentifier") {
        if (node.name !== undefined && folders.has(node.name)) report(node.name, node)
      }
    }
    /** A string that is a tag or holds `<Tag`. */
    const text = (value: unknown, node: Node) => {
      if (typeof value !== "string") return
      if (folders.has(value)) return report(value, node)
      if (tagInText === undefined) return
      for (const [, tag] of value.matchAll(tagInText)) if (tag !== undefined) report(tag, node)
    }

    return {
      Literal: (node: Node) => text(node.value, node),
      TemplateElement: (node: Node) => {
        const value = node.value as { readonly cooked?: string | null; readonly raw: string }
        text(value.cooked ?? value.raw, node)
      },
      Property: (node: Node) => node.computed === true || name(node.key),
      TSPropertySignature: (node: Node) => node.computed === true || name(node.key),
      JSXIdentifier: (node: Node) => name(node),
      ExportSpecifier: (node: Node) => name(node.exported),
      ...(file === REGISTRY ? { Program: (node: Node) => registryLines(node, context) } : {}),
    }
  },
}

/** Reports each statement in the registry that is not one registry line. `export {}` keeps an empty registry a module. */
function registryLines(program: Node, context: Context): void {
  for (const node of program.body ?? []) {
    const line = context.sourceCode.lines[node.loc.start.line - 1] ?? ""
    const exports = node.type === "ExportNamedDeclaration" && !node.declaration
    const empty = exports && node.source === null && node.specifiers?.length === 0
    const one = exports && node.specifiers?.length === 1 && REGISTRY_LINE.test(line)
    if (!empty && !one) context.report({ node, messageId: "notALine" })
  }
}

export default {
  meta: { name: "runbooks" },
  rules: {
    "no-relative-import-across-packages": noRelativeImportAcrossPackages,
    "no-import-between-blocks": noImportBetweenBlocks,
    "no-react-in-block-ts": noReactInBlockTs,
    "block-name-outside-its-folder": blockNameOutsideItsFolder,
  },
}
