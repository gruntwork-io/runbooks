/**
 * Runs oxlint over a tree of its own, in a temporary folder, with this
 * plugin's rules or with the repo's .oxlintrc.json, and reads what each rule
 * reports.
 */
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin from "./oxlint-plugin.ts"

const REPO = path.resolve(import.meta.dirname, "..")
const OXLINT = path.join(REPO, "node_modules", ".bin", "oxlint")
const PLUGIN = path.join(REPO, "scripts", "oxlint-plugin.ts")
const RULES = [
  "no-relative-import-across-packages",
  "no-import-between-blocks",
  "no-react-in-block-ts",
  "no-node-in-block-ts",
  "block-name-outside-its-folder",
  "plugin-binary-outside-owner",
  "no-computed-import",
]

interface Finding {
  readonly rule: string
  readonly file: string
  readonly line: number
  readonly message: string
}

interface Diagnostic {
  readonly code: string
  readonly filename: string
  readonly message: string
  readonly labels: ReadonlyArray<{ readonly span: { readonly line: number } }>
}

interface Config {
  readonly options?: Record<string, unknown>
  readonly jsPlugins?: ReadonlyArray<{ readonly name: string; readonly specifier: string }>
}

/**
 * The repo's .oxlintrc.json, made to run from another folder: its plugins by
 * absolute path, and no type-aware rules, which need a TypeScript project the
 * tree doesn't have. Its overrides match paths from the tree's root.
 */
function repoConfig(): Config {
  const config = JSON.parse(readFileSync(path.join(REPO, ".oxlintrc.json"), "utf8")) as Config
  const { typeAware: _, ...options } = config.options ?? {}
  return {
    ...config,
    options,
    jsPlugins: (config.jsPlugins ?? []).map(({ name, specifier }) => ({
      name,
      specifier: specifier.startsWith("./")
        ? path.join(REPO, specifier)
        : Bun.resolveSync(specifier, REPO),
    })),
  }
}

/**
 * Runs oxlint over `files`, in a temporary folder, with `args`: with every
 * rule of this plugin, or with `config` when one is given.
 */
function oxlint(files: Record<string, string>, args: ReadonlyArray<string>, config?: Config) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "runbooks-lint-")))
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), text)
    }
    const rules = {
      jsPlugins: [{ name: "runbooks", specifier: PLUGIN }],
      rules: Object.fromEntries(RULES.map((rule) => [`runbooks/${rule}`, ["error", { root }]])),
    }
    writeFileSync(path.join(root, ".oxlintrc.json"), JSON.stringify(config ?? rules))
    const run = Bun.spawnSync([OXLINT, "-c", ".oxlintrc.json", ...args, "."], { cwd: root })
    return { exitCode: run.exitCode, output: run.stdout.toString() }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** What oxlint reports on `files`, by its rule code and path from the tree's root, in file and line order. */
function diagnose(files: Record<string, string>, config?: Config): Finding[] {
  const { diagnostics } = JSON.parse(oxlint(files, ["-f", "json"], config).output) as {
    diagnostics: ReadonlyArray<Diagnostic>
  }
  return diagnostics
    .map((d) => ({
      rule: d.code,
      file: d.filename,
      line: d.labels[0]?.span.line ?? 0,
      message: d.message,
    }))
    .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
}

/** What this plugin's rules report on `files`, by rule name. */
function lint(files: Record<string, string>): Finding[] {
  return diagnose(files)
    .filter((f) => f.rule.startsWith("runbooks("))
    .map((f) => ({ ...f, rule: f.rule.slice("runbooks(".length, -1) }))
}

/** Each finding as `rule file:line`. */
const brief = (found: ReadonlyArray<Finding>) => found.map((f) => `${f.rule} ${f.file}:${f.line}`)

describe("no-relative-import-across-packages", () => {
  it("reports a relative import into another package, and not one inside a package", () => {
    const found = lint({
      "packages/cli/src/main.ts": 'export * from "../../core/src/engine/protocol.ts"\n',
      "packages/core/src/a.ts": 'export * from "./b.ts"\n',
    })
    expect(found).toEqual([
      {
        rule: "no-relative-import-across-packages",
        file: "packages/cli/src/main.ts",
        line: 1,
        message:
          "../../core/src/engine/protocol.ts crosses from cli into core. Import a package by name, as @runbooks/<package>/<export>, from a package that references it.",
      },
    ])
  })
})

describe("no-import-between-blocks", () => {
  it("reports a block folder importing another block, the registry or the view map", () => {
    const found = lint({
      "blocks/command/block.ts": [
        'export * from "../check/block.ts"',
        'export * from "./shell.ts"',
        'export * from "@runbooks/blocks-core/contract"',
        'export * from "@runbooks/core/protocol"',
      ].join("\n"),
      "blocks/command/View.tsx": [
        'export * from "@runbooks/blocks"',
        'export * from "../views.ts"',
        'export const load = () => import("../check/View.tsx")',
      ].join("\n"),
      "blocks/index.ts": 'export { command as Command } from "./command/block.ts"\n',
    })
    expect(brief(found)).toEqual([
      "no-import-between-blocks blocks/command/View.tsx:1",
      "no-import-between-blocks blocks/command/View.tsx:2",
      "no-import-between-blocks blocks/command/View.tsx:3",
      "no-import-between-blocks blocks/command/block.ts:1",
    ])
    expect(found.map((f) => f.message)).toEqual([
      "@runbooks/blocks reaches from blocks/command/ into the registry. A block imports no other block: code two blocks need moves to blocks/core or a service.",
      "../views.ts reaches from blocks/command/ into blocks/views.ts. A block imports no other block: code two blocks need moves to blocks/core or a service.",
      "../check/View.tsx reaches from blocks/command/ into blocks/check/. A block imports no other block: code two blocks need moves to blocks/core or a service.",
      "../check/block.ts reaches from blocks/command/ into blocks/check/. A block imports no other block: code two blocks need moves to blocks/core or a service.",
    ])
  })
})

describe("no-react-in-block-ts", () => {
  it("reports React or a .tsx file in block.ts, and not in the block's view", () => {
    const react = [
      'export * from "react"',
      'export * from "react-dom/client"',
      'export * from "./View.tsx"',
    ]
    const found = lint({
      "blocks/command/block.ts": [...react, 'export * from "./reactive.ts"'].join("\n"),
      "blocks/command/View.tsx": react.slice(0, 2).join("\n"),
    })
    expect(brief(found)).toEqual([
      "no-react-in-block-ts blocks/command/block.ts:1",
      "no-react-in-block-ts blocks/command/block.ts:2",
      "no-react-in-block-ts blocks/command/block.ts:3",
    ])
    expect(found[2]?.message).toBe(
      "block.ts imports ./View.tsx. The engine and the CLI load block.ts, so it imports no React: the view goes in View.tsx and a line in blocks/views.ts.",
    )
  })
})

describe("no-node-in-block-ts", () => {
  it("reports a Node built-in in block.ts, with or without node:, and not in its tests", () => {
    const node = [
      'export * from "node:path"',
      'export * from "path"',
      'export * from "crypto"',
      'export * from "fs/promises"',
    ]
    const found = lint({
      "blocks/command/block.ts": [
        ...node,
        'export * from "effect"',
        'export * from "./pathy.ts"',
      ].join("\n"),
      "blocks/command/block.test.ts": node.join("\n"),
    })
    expect(brief(found)).toEqual([
      "no-node-in-block-ts blocks/command/block.ts:1",
      "no-node-in-block-ts blocks/command/block.ts:2",
      "no-node-in-block-ts blocks/command/block.ts:3",
      "no-node-in-block-ts blocks/command/block.ts:4",
    ])
    expect(found[0]?.message).toBe(
      "block.ts imports node:path. Every client loads block.ts, the renderer included, so it imports no Node built-in: it reaches the OS through the services its run gets, and pure helpers go in packages/core.",
    )
  })
})

describe("block-name-outside-its-folder", () => {
  /** Command and GitHubAuth (an alias) are registered; Check is only in the baseline. */
  const tree = {
    "blocks/index.ts": [
      "/** The registry. */",
      'export { command as Command } from "./command/block.ts"',
      'export { gitHubAuth as GitHubAuth } from "./git-auth/block.ts"',
    ].join("\n"),
    "baseline/props.json": JSON.stringify({ Check: [], Command: [] }),
  }

  it("reports code that names a block: its tag as a string, `<Tag` in text, a key, an element", () => {
    const found = lint({
      ...tree,
      "packages/core/src/engine.ts": [
        'export const a = "Command"',
        "export const b = 'run <Command id=\"x\" /> first'",
        "export const c = { Command: 1 }",
        "export type D = { GitHubAuth: string }",
        'export const e = "Check"',
        "export const f = `<Check>`",
        'export { a as GitHubAuth } from "./x.ts"',
      ].join("\n"),
      "packages/core/src/engine.test.ts": "export const g = '<Command id=\"a\" />'\n",
      "packages/app-renderer/src/Frame.tsx": "export const h = <Command />\n",
    })
    expect(brief(found)).toEqual([
      "block-name-outside-its-folder packages/app-renderer/src/Frame.tsx:1",
      "block-name-outside-its-folder packages/core/src/engine.test.ts:1",
      ...[1, 2, 3, 4, 5, 6, 7].map(
        (line) => `block-name-outside-its-folder packages/core/src/engine.ts:${line}`,
      ),
    ])
    expect(found[2]?.message).toBe(
      "Command is the block in blocks/command/. Only that folder and its lines in blocks/index.ts and blocks/views.ts may name it: elsewhere, ask the registry, or key on a class or capability.",
    )
    expect(found[6]?.message).toBe(
      "Check is a block the rebuild carries (baseline/props.json). Only its folder and its registry lines may name it: elsewhere, ask the registry, or key on a class or capability.",
    )
  })

  it("leaves comments, prose, imported names, and files outside the packages alone", () => {
    const found = lint({
      ...tree,
      "packages/core/src/engine.ts": [
        "// <Command> and <Check> in a comment",
        'export const a = "Check your network connection"',
        'export const b = "<CommandLine>"',
        'import { Command } from "effect/cli"',
        "export const c = Command",
      ].join("\n"),
      "baseline/blocks.ts": 'export const blocks = ["Command", "Check"]\n',
      "scripts/x.ts": 'export const tag = "Command"\n',
    })
    expect(found).toEqual([])
  })

  it("lets a block's folder and its registry lines name it, and nothing else", () => {
    const found = lint({
      ...tree,
      "blocks/command/block.ts": 'export const name = "Command"\nexport const sibling = "Check"\n',
      "blocks/git-auth/block.ts": 'export const name = "GitHubAuth"\n',
      "blocks/views.ts": [
        'export const views = { Command: () => import("./command/View.tsx") }',
        "export const others = { GitHubAuth: 1 }",
      ].join("\n"),
    })
    expect(brief(found)).toEqual([
      "block-name-outside-its-folder blocks/command/block.ts:2",
      "block-name-outside-its-folder blocks/views.ts:2",
    ])
  })

  it("holds blocks/index.ts to registry lines, so the rule reads every tag", () => {
    const found = lint({
      "blocks/index.ts": [
        'export { command as Command } from "./command/block.ts"',
        'import { check } from "./check/block.ts"',
        'export { check as Check, other as Other } from "./check/block.ts"',
        "export const Extra = check",
      ].join("\n"),
    })
    expect(brief(found)).toEqual([
      "block-name-outside-its-folder blocks/index.ts:2",
      "block-name-outside-its-folder blocks/index.ts:3",
      "block-name-outside-its-folder blocks/index.ts:4",
    ])
    expect(found[0]?.message).toBe(
      'blocks/index.ts holds one line per block or alias, naming the block\'s block.ts, `export { command as Command } from "./command/block.ts"`, and nothing else.',
    )
    expect(lint({ "blocks/index.ts": "/** No blocks yet. */\nexport {}\n" })).toEqual([])
  })

  it("holds each registry line to a block's block.ts, so the registry loads no view", () => {
    const found = lint({
      "blocks/index.ts": [
        'export { command as Command } from "./command/View.tsx"',
        'export { check as Check } from "./check/check.ts"',
        'export { gitHubAuth as GitHubAuth } from "./git-auth/block.ts"',
      ].join("\n"),
    })
    expect(brief(found)).toEqual([
      "block-name-outside-its-folder blocks/index.ts:1",
      "block-name-outside-its-folder blocks/index.ts:2",
    ])
    expect(found[0]?.message).toContain('"./command/block.ts"')
  })
})

describe("plugin-binary-outside-owner", () => {
  /** The transport contract as it is, so the rule reads today's kinds from it. */
  const TRANSPORT = "packages/core/src/plugin/transport.ts"
  const contract = { [TRANSPORT]: readFileSync(path.join(REPO, TRANSPORT), "utf8") }
  const OWNER = "packages/platform-node/src/layers/NodePluginProcess.ts"

  it("reports a plugin binary's name, or one being built, anywhere in the packages but the owner", () => {
    const found = lint({
      ...contract,
      "packages/app-main/src/start.ts": [
        'import { spawn } from "node:child_process"',
        'export const a = () => spawn("/opt/runbooks/bin/runbooks-credential-aws", [])',
        "export const b = (name: string) => `runbooks-driver-${name}`",
        'export const c = (kind: string) => "runbooks-" + kind',
        "export const d = (kind: string, name: string) => `${kind}/runbooks-${kind}-${name}`",
        'export type E = "runbooks-credential-google.exe"',
      ].join("\n"),
      "packages/platform-node/src/layers/NodePluginProcess.test.ts":
        'export const stub = "runbooks-credential-stub"\n',
    })
    expect(brief(found)).toEqual([
      ...[2, 3, 4, 5, 6].map(
        (line) => `plugin-binary-outside-owner packages/app-main/src/start.ts:${line}`,
      ),
      "plugin-binary-outside-owner packages/platform-node/src/layers/NodePluginProcess.test.ts:1",
    ])
    expect(found[0]?.message).toBe(
      "runbooks-credential- names a plugin binary, `runbooks-<kind>-<name>`. Only packages/platform-node/src/layers/NodePluginProcess.ts starts a plugin: open one through PluginProcess, by its registry name.",
    )
    expect(found[2]?.message.startsWith("runbooks- names a plugin binary")).toBe(true)
  })

  it("leaves the owner, comments, Command's and git's spawns, other runbooks- names, and files outside the packages alone", () => {
    const found = lint({
      ...contract,
      [OWNER]:
        "export const binaryName = (kind: string, name: string) => `runbooks-${kind}-${name}`\n",
      "packages/platform-node/src/layers/NodeSpawner.ts": [
        'import { spawn } from "node:child_process"',
        "// runbooks-credential-aws is started by the owner, not here",
        'export const git = (url: string) => spawn("git", ["clone", "--", url])',
        'export const command = (script: string) => spawn("bash", ["-c", script])',
        'export const workDir = "runbooks-run-"',
        'export const author = "runbooks-noreply@gruntwork.io"',
        'export const adc = "/tmp/runbooks-gcp-A7oaHl/adc.json"',
      ].join("\n"),
      "src/legacy.ts": 'export const old = "runbooks-credential-aws"\n',
      "scripts/x.ts": 'export const x = "runbooks-driver-tofu"\n',
    })
    expect(found).toEqual([])
  })

  it("fails the lint when it cannot read the kinds from the transport contract", () => {
    const { exitCode, output } = oxlint(
      {
        [TRANSPORT]: 'export const PluginKind = Schema.Literal("credential")\n',
        "packages/core/src/a.ts": 'export const a = "runbooks-credential-aws"\n',
      },
      ["-f", "default"],
    )
    expect(exitCode).toBe(1)
    expect(output).toContain(
      "packages/core/src/plugin/transport.ts declares no `export const PluginKind = Schema.Literals([...])`",
    )
  })
})

describe("no-computed-import", () => {
  it("reports an import() that names its module with a template literal, in any package", () => {
    const found = lint({
      "blocks/command/block.ts": "export const a = () => import(`react`)\n",
      "packages/cli/src/main.ts":
        "export const b = () => import(`../../core/src/engine/protocol.ts`)\n",
      "packages/platform-node/src/wasm.ts":
        'const dir = "/opt"\nexport const c = () => import(`${dir}/wasm_exec.js`)\n',
      "scripts/x.ts": "export const d = () => import(`./y.ts`)\n",
    })
    expect(brief(found)).toEqual([
      "no-computed-import blocks/command/block.ts:1",
      "no-computed-import packages/cli/src/main.ts:1",
      "no-computed-import packages/platform-node/src/wasm.ts:2",
    ])
    expect(found[0]?.message).toBe(
      'import() names its module with a template literal, which no import rule reads. Write it as a plain string: import("./x.ts").',
    )
  })

  it("reports any other module chosen at run time in the core and the blocks, and not in the layers", () => {
    const load = "export const load = (name: string) => import(name)\n"
    const found = lint({
      "blocks/core/load.ts": load,
      "blocks/command/block.ts": 'export const load = (name: string) => import("./" + name)\n',
      "packages/core/src/load.ts": load,
      "packages/core/src/view.ts": 'export const view = () => import("./x.ts")\n',
      "packages/platform-node/src/load.ts": load,
    })
    expect(brief(found)).toEqual([
      "no-computed-import blocks/command/block.ts:1",
      "no-computed-import blocks/core/load.ts:1",
      "no-computed-import packages/core/src/load.ts:1",
    ])
    expect(found[1]?.message).toBe(
      'blocks/core does no I/O, so it loads no module chosen at run time: name the module with a plain string, import("./x.ts"), which the import rules read.',
    )
  })
})

describe(".oxlintrc.json", () => {
  /** What the repo's config reports on `files` under `rule`, a built-in rule's code. */
  const reported = (rule: string, files: Record<string, string>) =>
    diagnose(files, repoConfig()).filter((f) => f.rule === rule)

  it("keeps the core and the blocks off process, fetch, Bun and globalThis, and not their tests or the layers", () => {
    const io = [
      "export const a = process.env.HOME",
      'export const b = () => fetch("https://example.com")',
      'export const c = Bun.file("x")',
      "export const d = globalThis.fetch",
    ].join("\n")
    const found = reported("eslint(no-restricted-globals)", {
      "packages/core/src/io.ts": io,
      "blocks/core/io.ts": io,
      "blocks/command/block.ts": io,
      "packages/core/src/io.test.ts": io,
      "packages/platform-node/src/io.ts": io,
    })
    expect(brief(found)).toEqual(
      ["blocks/command/block.ts", "blocks/core/io.ts", "packages/core/src/io.ts"].flatMap((file) =>
        [1, 2, 3, 4].map((line) => `eslint(no-restricted-globals) ${file}:${line}`),
      ),
    )
    expect(found.at(-1)?.message).toContain("Only packages/platform-node")
  })

  it("keeps the core and the blocks from importing process, module or bun, and not their tests", () => {
    const imports = [
      'import { env } from "node:process"',
      'import { createRequire } from "module"',
      'import { file } from "bun"',
      'import { Database } from "bun:sqlite"',
      "export const x = [env, createRequire, file, Database]",
    ].join("\n")
    const found = reported("eslint(no-restricted-imports)", {
      "packages/core/src/imports.ts": imports,
      "blocks/command/block.ts": imports,
      "packages/core/src/imports.test.ts": imports,
      "packages/platform-node/src/imports.ts": imports,
    })
    expect(brief(found)).toEqual(
      ["blocks/command/block.ts", "packages/core/src/imports.ts"].flatMap((file) =>
        [1, 2, 3, 4].map((line) => `eslint(no-restricted-imports) ${file}:${line}`),
      ),
    )
  })
})

describe("the plugin", () => {
  it("has every rule on in .oxlintrc.json, as an error", () => {
    const config = JSON.parse(readFileSync(path.join(REPO, ".oxlintrc.json"), "utf8")) as {
      readonly rules: Record<string, unknown>
    }
    const rules = Object.keys(plugin.rules)
    expect(rules).toEqual(RULES)
    expect(rules.map((rule) => config.rules[`runbooks/${rule}`])).toEqual(rules.map(() => "error"))
  })
})
