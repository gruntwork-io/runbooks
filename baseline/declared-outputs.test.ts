/**
 * Decision 8, ruled as recommended: a Command declares the outputs its
 * script writes (`outputs`), and a template that reads an output its block
 * does not declare is a configuration error, so the block that reads it
 * never runs. No testdata runbook has one.
 *
 * The check is the new tree's own, through the registry: a block it does
 * not have yet is not checked, nor the reads inside it, until it is added.
 */
import { describe, expect, it } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import * as registry from "@runbooks/blocks"
import { configErrors } from "@runbooks/core/document/document"
import { loadRunbook } from "@runbooks/core/document/load"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { RUNBOOKS_VERSION } from "../src/runbooks-version.ts"

const ROOT = path.resolve(import.meta.dir, "..")

const RUNBOOKS = [...new Bun.Glob("testdata/**/runbook.mdx").scanSync(ROOT)].sort((a, b) =>
  a.localeCompare(b),
)

/** Each read in `runbook` of an output its block does not declare, at its line. */
const undeclaredReads = (runbook: string) =>
  loadRunbook(path.join(ROOT, runbook), registry, { appVersion: RUNBOOKS_VERSION }).pipe(
    Effect.map((result) =>
      configErrors(result)
        .filter((error) => error.code === "undeclaredOutput")
        .map(
          ({ location, message }) =>
            `${path.relative(ROOT, location.file)}:${location.span.start.line}: ${message}`,
        ),
    ),
  )

describe("declared outputs, against the testdata runbooks", () => {
  it("finds no runbook that reads an output its block does not declare", async () => {
    expect(RUNBOOKS.length).toBeGreaterThanOrEqual(44)
    const reads = await Effect.runPromise(
      Effect.forEach(RUNBOOKS, undeclaredReads).pipe(Effect.provide(NodeFileSystemLive)),
    )
    expect(reads.flat()).toEqual([])
  })
})
