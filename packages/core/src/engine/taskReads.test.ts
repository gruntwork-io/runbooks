import { describe, expect, it } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import type { BlockOutputs } from "@runbooks/blocks-core/contract"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import { type UseEnvSession, withEnvSession } from "../test-utils/envSessions.ts"
import { FileSystem } from "../services/FileSystem.ts"
import { testFileSystem } from "../test-utils/TestFileSystem.ts"
import { makeRecordingSpawner } from "../test-utils/TestSpawner.ts"

// What a task reads from the session beside what its run makes: the files
// it names and the outputs its templates name. Both are already in the
// engine, so a run gets them with no I/O, and so can instruction mode.

const RUNBOOK = "/rb/runbook.mdx"
const SCRIPT = "/rb/scripts/a.sh"
const done: BlockStatus = { _tag: "Done", outcome: "success" }

/** A trusted session of `files`' runbook, `files` kept by reference so a test can change one. */
const withSession = <A>(files: Record<string, string>, use: UseEnvSession<A>): Promise<A> =>
  withEnvSession(
    {
      file: RUNBOOK,
      workingFolders: "/work",
      processEnvironment: { PATH: "/usr/bin" },
      fileSystem: Layer.succeed(FileSystem, testFileSystem(files, ["/rb"])),
      spawner: makeRecordingSpawner(() => ({ lines: [], exitCode: 0 })).layer,
    },
    use,
  )

/** Each block's outputs, revealed. */
const revealedOutputs = (outputs: BlockOutputs | undefined) =>
  Object.fromEntries(
    Array.from(outputs ?? [], ([block, keys]) => [
      block,
      Object.fromEntries(Array.from(keys, ([key, value]) => [key, Redacted.value(value)])),
    ]),
  )

describe("a run", () => {
  it("gets the files it names as they were hashed when the runbook opened", async () => {
    const files = {
      [RUNBOOK]: '<Run id="r" command="r" path="scripts/a.sh" />',
      [SCRIPT]: "echo trusted",
    }
    const read = await withSession(files, (rb) =>
      Effect.gen(function* () {
        files[SCRIPT] = "echo changed after trust"
        expect(yield* rb.run("r")).toEqual(done)
        return rb.inputOf("r")?.files
      }),
    )
    expect(read).toEqual(new Map([["scripts/a.sh", "echo trusted"]]))
  })

  it("gets each output its templates name, redacted, and no other block's or key's", async () => {
    const files = {
      [RUNBOOK]: [
        '<Script id="s" label="s" writesOutput={["k=v", "secret=hidden", "unread=u"]} declares={["k", "secret", "unread"]} />',
        '<Script id="other" label="other" writesOutput={["o=1"]} declares={["o"]} />',
        '<Run id="r" command="r" path="scripts/a.sh" />',
      ].join("\n\n"),
      [SCRIPT]: "echo {{ .outputs.s.k }} {{ .outputs.s.secret }}",
    }
    const outputs = await withSession(files, (rb) =>
      Effect.gen(function* () {
        yield* rb.run("s")
        yield* rb.run("other")
        expect(yield* rb.run("r")).toEqual(done)
        return rb.inputOf("r")?.outputs
      }),
    )
    for (const [, keys] of outputs ?? [])
      for (const [, value] of keys) expect(Redacted.isRedacted(value)).toBe(true)
    expect(revealedOutputs(outputs)).toEqual({ s: { k: "v", secret: "hidden" } })
  })

  it("gets no outputs when its templates name none", async () => {
    const files = {
      [RUNBOOK]: [
        '<Script id="s" label="s" writesOutput={["k=v"]} declares={["k"]} />',
        '<Run id="r" command="r" dependsOn={["s"]} />',
      ].join("\n\n"),
    }
    const outputs = await withSession(files, (rb) =>
      Effect.gen(function* () {
        yield* rb.run("s")
        expect(yield* rb.run("r")).toEqual(done)
        return rb.inputOf("r")?.outputs
      }),
    )
    expect(outputs).toEqual(new Map())
  })
})
