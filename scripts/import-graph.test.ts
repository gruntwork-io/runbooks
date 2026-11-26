/**
 * Every client loads each block's block.ts, the renderer included, so
 * nothing it loads, through its own imports or the core's, may be a Node or
 * Bun built-in, React or a view. no-node-in-block-ts and no-react-in-block-ts
 * read block.ts's own imports; this follows the rest.
 */
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { isBuiltin } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { type ImportGraph, type Loaded, importGraph } from "./import-graph.ts"

const REPO = path.resolve(import.meta.dirname, "..")
const REACT = /^react(-dom)?(\/|$)/

/** `files`, with the aliases `paths`, in a temporary folder, and the import graph of `entry` there. */
function graphOf(
  files: Record<string, string>,
  paths: Record<string, ReadonlyArray<string>>,
  entry: string,
): ImportGraph {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "runbooks-graph-")))
  try {
    const config = { compilerOptions: { paths } }
    writeFileSync(path.join(root, "tsconfig.packages.json"), JSON.stringify(config))
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), text)
    }
    return importGraph(root, entry)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Each import path to a built-in, React or a view, as `entry -> ... -> module`. */
function forbidden({ files, modules }: ImportGraph): string[] {
  const chain = ({ name, via }: Loaded) => [...via, name].join(" -> ")
  return [
    ...modules.filter(({ name }) => isBuiltin(name) || REACT.test(name)).map(chain),
    ...files.filter(({ name }) => name.endsWith(".tsx")).map(chain),
  ]
}

describe("importGraph", () => {
  it("follows relative imports, aliases and string import(), and not type imports", () => {
    const graph = graphOf(
      {
        "blocks/command/block.ts": [
          'import { Effect } from "effect"',
          'import type { ReactNode } from "react"',
          'import { quote } from "./quote.ts"',
          'export { script } from "@runbooks/core/domain/exec/script"',
          'export const view = () => import("./lazy.tsx")',
          "export const use = [Effect, quote]",
        ].join("\n"),
        "blocks/command/quote.ts": 'import { join } from "node:path"\nexport const quote = join\n',
        "blocks/command/lazy.tsx": 'export * from "react"\n',
        "packages/core/src/domain/exec/script.ts": [
          'import { Schema } from "effect"',
          'import { createHash } from "crypto"',
          "export const script = [Schema, createHash]",
        ].join("\n"),
      },
      { "@runbooks/core/domain/*": ["./packages/core/src/domain/*.ts"] },
      "blocks/command/block.ts",
    )
    const block = "blocks/command/block.ts"

    expect(graph.files).toEqual([
      { name: block, via: [] },
      { name: "blocks/command/quote.ts", via: [block] },
      { name: "packages/core/src/domain/exec/script.ts", via: [block] },
      { name: "blocks/command/lazy.tsx", via: [block] },
    ])
    expect(graph.modules).toEqual([
      { name: "effect", via: [block] },
      { name: "node:path", via: [block, "blocks/command/quote.ts"] },
      { name: "crypto", via: [block, "packages/core/src/domain/exec/script.ts"] },
      { name: "react", via: [block, "blocks/command/lazy.tsx"] },
    ])
    expect(forbidden(graph)).toEqual([
      `${block} -> blocks/command/quote.ts -> node:path`,
      `${block} -> packages/core/src/domain/exec/script.ts -> crypto`,
      `${block} -> blocks/command/lazy.tsx -> react`,
      `${block} -> blocks/command/lazy.tsx`,
    ])
  })
})

describe("each block's block.ts", () => {
  const blocks = [...new Bun.Glob("blocks/*/block.ts").scanSync({ cwd: REPO })].sort()

  it("is found", () => {
    expect(blocks).toContain("blocks/command/block.ts")
  })

  it.each(blocks)("%s loads no Node or Bun built-in, no React and no view", (block) => {
    expect(forbidden(importGraph(REPO, block))).toEqual([])
  })
})
