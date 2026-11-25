/**
 * Runs oxlint with this plugin over a tree of its own, in a temporary folder,
 * and reads what each rule reports.
 */
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const REPO = path.resolve(import.meta.dirname, "..")
const OXLINT = path.join(REPO, "node_modules", ".bin", "oxlint")
const PLUGIN = path.join(REPO, "scripts", "oxlint-plugin.ts")
const RULES = [
  "no-relative-import-across-packages",
  "no-import-between-blocks",
  "no-react-in-block-ts",
  "block-name-outside-its-folder",
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

/** What this plugin's rules report on `files`, by path from the tree's root, in file and line order. */
function lint(files: Record<string, string>): Finding[] {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "runbooks-lint-")))
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), text)
    }
    const config = {
      jsPlugins: [{ name: "runbooks", specifier: PLUGIN }],
      rules: Object.fromEntries(RULES.map((rule) => [`runbooks/${rule}`, ["error", { root }]])),
    }
    writeFileSync(path.join(root, ".oxlintrc.json"), JSON.stringify(config))
    const run = Bun.spawnSync([OXLINT, "-c", ".oxlintrc.json", "-f", "json", "."], { cwd: root })
    const { diagnostics } = JSON.parse(run.stdout.toString()) as {
      diagnostics: ReadonlyArray<Diagnostic>
    }
    return diagnostics
      .filter((d) => d.code.startsWith("runbooks("))
      .map((d) => ({
        rule: d.code.slice("runbooks(".length, -1),
        file: d.filename,
        line: d.labels[0]?.span.line ?? 0,
        message: d.message,
      }))
      .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
      'blocks/index.ts holds one line per block or alias, `export { command as Command } from "./command/block.ts"`, and nothing else.',
    )
    expect(lint({ "blocks/index.ts": "/** No blocks yet. */\nexport {}\n" })).toEqual([])
  })
})
