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
 * Only `block.ts`'s own imports are checked: scripts/import-graph.test.ts
 * follows the rest, through the packages' aliases.
 *
 * no-node-in-block-ts: a block's `block.ts` imports no Node built-in, not even
 * `node:path`, so every client loads it, the renderer included. It reaches
 * the OS through the services its run gets, and pure helpers it needs live
 * in `packages/core`. Only `block.ts`'s own imports are checked, as for
 * no-react-in-block-ts.
 *
 * block-name-outside-its-folder: no file in the packages names a block
 * outside the block's folder and its lines in the registry files, so adding
 * or removing a block touches one folder and those lines. The blocks are the
 * tags in `blocks/index.ts` and the frozen baseline's blocks
 * (`baseline/props.json`), which the rebuild carries. Code names a block
 * when a string is its tag or holds `<Tag`, or a key, JSX element or export
 * is named for it. Comments and prose are not checked: "Check" and "Template"
 * are words too.
 *
 * plugin-binary-outside-owner: no file in the packages but the transport
 * owner names a plugin binary, so nothing else can start one. A binary is
 * `runbooks-<kind>-<name>` for a kind in `PluginKind`, read from the
 * transport contract. Code names one when a string holds `runbooks-<kind>-`,
 * or ends in `runbooks-` for a kind to follow, as `"runbooks-" + kind` and
 * `` `runbooks-${kind}-` `` do. Command's and git's spawns name no plugin,
 * and comments are not checked.
 *
 * no-computed-import: an `import()` in the packages names its module with a
 * plain string, which every import rule reads, and not a template literal,
 * which none does. The core and the blocks do no I/O, so their `import()`
 * names no module chosen at run time either; the layers may, to load a file
 * they found.
 *
 * blocks-core-imports-only-effect: blocks/core, the block contract, imports
 * `effect` and its own files and nothing else, types included, so every
 * block and every client can load it. Its tests also import `bun:test`.
 */
import { existsSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import path from "node:path"
import { PACKAGES, packageOf, type PackageName } from "./packages.ts"

const REPO = path.resolve(import.meta.dirname, "..")

/** The registry: one line per block or alias. */
const REGISTRY = "blocks/index.ts"
/** The files a block adds its lines to. */
const REGISTRY_FILES: ReadonlySet<string> = new Set([REGISTRY, "blocks/views.ts"])
/** The blocks the frozen baseline holds, by tag. */
const BASELINE_BLOCKS = "baseline/props.json"

/**
 * One registry line, `export { command as Command } from "./command/block.ts"`.
 * It names the block's block.ts, the file the engine and the CLI load through
 * the registry: a line naming the view would load React into them.
 */
const REGISTRY_LINE = /^export \{ (\w+) as (\w+) \} from "\.\/([\w-]+)\/block\.ts"$/

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
  readonly property?: Node
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

/** Node's built-in modules, by bare name, with or without `node:`, and any `node:` import. */
const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules)
const isNodeBuiltin = (spec: string) =>
  spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0] ?? spec)

const noNodeInBlockTs = {
  meta: {
    type: "problem",
    docs: { description: "A block's block.ts may not import a Node built-in" },
    messages: {
      node: "block.ts imports {{spec}}. Every client loads block.ts, the renderer included, so it imports no Node built-in: it reaches the OS through the services its run gets, and pure helpers go in packages/core.",
    },
    schema: ROOT_OPTION,
  },
  create(context: Context) {
    const { file } = fileOf(context)
    const folder = blockFolderOf(file)
    if (folder === undefined || file !== `blocks/${folder}/block.ts`) return {}
    return imports((node) => {
      const spec = specOf(node)
      if (spec === undefined || !isNodeBuiltin(spec)) return
      context.report({ node: node.source, messageId: "node", data: { spec } })
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
        'blocks/index.ts holds one line per block or alias, naming the block\'s block.ts, `export { command as Command } from "./command/block.ts"`, and nothing else.',
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

/** The one file that may name a plugin binary: it starts every plugin. */
const PLUGIN_OWNER = "packages/platform-node/src/layers/NodePluginProcess.ts"
/** Where `PluginKind` is declared. */
const TRANSPORT = "packages/core/src/plugin/transport.ts"
const PLUGIN_KIND = /^export const PluginKind = Schema\.Literals\(\[([^\]]*)\]\)$/m

const pluginBinaryByRoot = new Map<string, RegExp>()

/** `runbooks-<kind>-` for each kind under `root`, or `runbooks-` at the end. Read once per root. */
function pluginBinaryOf(root: string): RegExp {
  const known = pluginBinaryByRoot.get(root)
  if (known !== undefined) return known
  const transport = path.join(root, TRANSPORT)
  let kinds: string[] = []
  if (existsSync(transport)) {
    const [, literals] = PLUGIN_KIND.exec(readFileSync(transport, "utf8")) ?? []
    if (literals === undefined) {
      throw new Error(
        `${TRANSPORT} declares no \`export const PluginKind = Schema.Literals([...])\`: plugin-binary-outside-owner reads the kinds from it`,
      )
    }
    kinds = [...literals.matchAll(/"([\w-]+)"/g)].flatMap(([, kind]) =>
      kind === undefined ? [] : [kind],
    )
  }
  const binary = new RegExp(
    kinds.length > 0 ? `runbooks-(?:${kinds.join("|")})-|runbooks-$` : "runbooks-$",
  )
  pluginBinaryByRoot.set(root, binary)
  return binary
}

const pluginBinaryOutsideOwner = {
  meta: {
    type: "problem",
    docs: { description: "Only the transport owner may name a plugin binary" },
    messages: {
      named:
        "{{name}} names a plugin binary, `runbooks-<kind>-<name>`. Only {{owner}} starts a plugin: open one through PluginProcess, by its registry name.",
    },
    schema: ROOT_OPTION,
  },
  create(context: Context) {
    const { root, file } = fileOf(context)
    if (packageOf(file) === undefined || file === PLUGIN_OWNER) return {}
    const binary = pluginBinaryOf(root)
    const text = (value: unknown, node: Node) => {
      if (typeof value !== "string") return
      const [name] = binary.exec(value) ?? []
      if (name !== undefined) {
        context.report({ node, messageId: "named", data: { name, owner: PLUGIN_OWNER } })
      }
    }
    return {
      Literal: (node: Node) => text(node.value, node),
      TemplateElement: (node: Node) => {
        const value = node.value as { readonly cooked?: string | null; readonly raw: string }
        text(value.cooked ?? value.raw, node)
      },
    }
  },
}

/**
 * The packages that do no I/O of their own (the I/O rules in .oxlintrc.json),
 * so load no module chosen at run time.
 */
const NO_IO: ReadonlySet<PackageName> = new Set(["blocks-core", "core", "blocks"])

const noComputedImport = {
  meta: {
    type: "problem",
    docs: { description: "An import() names its module with a plain string" },
    messages: {
      template:
        'import() names its module with a template literal, which no import rule reads. Write it as a plain string: import("./x.ts").',
      computed:
        '{{dir}} does no I/O, so it loads no module chosen at run time: name the module with a plain string, import("./x.ts"), which the import rules read.',
    },
    schema: ROOT_OPTION,
  },
  create(context: Context) {
    const pkg = packageOf(fileOf(context).file)
    if (pkg === undefined) return {}
    return {
      ImportExpression: (node: Node) => {
        const source = node.source
        if (source?.type === "Literal" && typeof source.value === "string") return
        if (source?.type === "TemplateLiteral") {
          context.report({ node: source, messageId: "template" })
        } else if (NO_IO.has(pkg)) {
          context.report({ node: source, messageId: "computed", data: { dir: PACKAGES[pkg].dir } })
        }
      },
    }
  },
}

const EFFECT = /^effect(\/|$)/

const blocksCoreImportsOnlyEffect = {
  meta: {
    type: "problem",
    docs: { description: "blocks/core imports only effect and its own files" },
    messages: {
      other:
        "blocks/core imports {{spec}}. The block contract imports only effect, so every block and every client can load it: write what it needs with effect, or keep it out of the contract.",
    },
    schema: ROOT_OPTION,
  },
  create(context: Context) {
    const { file } = fileOf(context)
    if (packageOf(file) !== "blocks-core") return {}
    const test = file.endsWith(".test.ts")
    return imports((node) => {
      const spec = specOf(node)
      if (spec === undefined || EFFECT.test(spec) || spec.startsWith("./")) return
      // A relative import out of blocks/core is no-relative-import-across-packages'.
      if (spec.startsWith("../") || (test && spec === "bun:test")) return
      context.report({ node: node.source, messageId: "other", data: { spec } })
    })
  },
}

/**
 * Members whose call throws on a bad value or a failure: Schema's `*Sync`
 * decoders and encoders, `Effect.runSync`, `Option.getOrThrow` and kin.
 */
const THROWS = /Sync$|^getOrThrow(With)?$|^asserts$/

const noThrowInBlocks = {
  meta: {
    type: "problem",
    docs: { description: "Block code throws nothing: the parser and the engine call it" },
    messages: {
      throw:
        "Block code throws nothing, because the parser and the engine call it and a throw would end them: fail an Effect, or return a Result.",
      call: "{{name}} throws on a bad value. Block code throws nothing, because the parser and the engine call it and a throw would end them: decode in the block's props schema, or use the Effect or Result form.",
    },
    schema: ROOT_OPTION,
  },
  create(context: Context) {
    const { file } = fileOf(context)
    const pkg = packageOf(file)
    if ((pkg !== "blocks" && pkg !== "blocks-core") || !file.endsWith(".ts")) return {}
    if (file.endsWith(".test.ts")) return {}
    return {
      ThrowStatement: (node: Node) => context.report({ node, messageId: "throw" }),
      MemberExpression: (node: Node) => {
        const name = node.computed === true ? undefined : node.property?.name
        if (name === undefined || !THROWS.test(name)) return
        context.report({ node: node.property, messageId: "call", data: { name } })
      },
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
    "no-node-in-block-ts": noNodeInBlockTs,
    "block-name-outside-its-folder": blockNameOutsideItsFolder,
    "plugin-binary-outside-owner": pluginBinaryOutsideOwner,
    "no-computed-import": noComputedImport,
    "blocks-core-imports-only-effect": blocksCoreImportsOnlyEffect,
    "no-throw-in-blocks": noThrowInBlocks,
  },
}
