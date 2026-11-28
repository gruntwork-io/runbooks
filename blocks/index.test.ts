import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { Effect, Layer, Redacted } from "effect"
import type { BlockId } from "@runbooks/blocks-core/contract"
import { isAlias, registryProblems, resolveTag } from "@runbooks/blocks-core/registry"
import { loadRunbook } from "@runbooks/core/document/load"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { testFileSystem } from "@runbooks/core/test-utils/TestFileSystem"
import * as registry from "./index.ts"

describe("the registry", () => {
  it("files each entry under its own tag, and each alias under a block", () => {
    expect(registryProblems(registry)).toEqual([])
  })
})

const SECRET = "fake-secret-in-values-5e1d"

/** A map that holds the secret under every name it is asked for, and lists `listed`. */
class EveryName<V> extends Map<string, V> {
  private readonly value: V
  constructor(value: V, listed: ReadonlyArray<string>) {
    super(listed.map((name) => [name, value]))
    this.value = value
  }
  override get(): V {
    return this.value
  }
  override has(): boolean {
    return true
  }
}

const secret = Redacted.make(SECRET)
const READS_SECRET = {
  values: new EveryName(secret, ["token", "password", "region"]),
  outputs: new EveryName<ReadonlyMap<string, Redacted.Redacted<string>>>(
    new EveryName(secret, ["token"]),
    ["setup"],
  ) as unknown as ReadonlyMap<BlockId, ReadonlyMap<string, Redacted.Redacted<string>>>,
}

/** Each file under `folder`, by its path from it. */
const filesUnder = (folder: string) =>
  readdirSync(folder, { recursive: true, encoding: "utf8" }).filter((name) =>
    statSync(path.join(folder, name)).isFile(),
  )

const TESTDATA = filesUnder(import.meta.dir)
  .filter((name) => /^[^/]+\/testdata\/[^/]+\/runbook\.mdx$/.test(name))
  .sort()

describe("every block's instruction", () => {
  it("shows no value it reads, for each task and credential block in each block's testdata", async () => {
    const seen = new Set<string>()
    for (const runbook of TESTDATA) {
      const file = path.join(import.meta.dir, runbook)
      const folder = path.dirname(file)
      // The runbook's folder, every file in it, in memory.
      const texts = Object.fromEntries(
        filesUnder(folder).map((name) => [
          path.join(folder, name),
          readFileSync(path.join(folder, name), "utf8"),
        ]),
      )
      const loaded = await Effect.runPromise(
        loadRunbook(file, registry, { appVersion: "0.31.0" }).pipe(
          Effect.provide(Layer.succeed(FileSystem, testFileSystem(texts, [folder]))),
        ),
      )
      if (loaded._tag !== "Parsed") continue
      for (const node of loaded.document.blocks) {
        const block = resolveTag(registry, node.tag)?.block
        if (block === undefined || node.props === undefined) continue
        const files = new Map(
          block.runbookFiles(node.props).flatMap((named) => {
            const text = texts[path.join(folder, named)]
            return text === undefined ? [] : [[named, text] as const]
          }),
        )
        const shown =
          block.class === "task"
            ? block.instruction(node.props, { ...READS_SECRET, files })
            : block.class === "credential"
              ? block.instruction(node.props)
              : undefined
        if (shown === undefined) continue
        seen.add(block.name)
        expect(JSON.stringify(shown), `${runbook}: ${node.tag}`).not.toContain(SECRET)
      }
    }
    // A task or credential block with no testdata that has an instruction is no check at all.
    const instructed = Object.values(registry).flatMap((entry) =>
      !isAlias(entry) && (entry.class === "task" || entry.class === "credential")
        ? [entry.name]
        : [],
    )
    expect([...seen].sort()).toEqual(instructed.sort())
  })
})
