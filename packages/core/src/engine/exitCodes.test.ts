/**
 * How a process task's run ends (work product 2.5): the exit-code table, a
 * timeout and a stop, and what each does to the outputs and environment its
 * script wrote. The first four are named as today's
 * src/domain/exec/executor.test.ts tests.
 *
 * | Exit              | Status  | Outputs and env | Satisfies `dependsOn` and `envFrom` |
 * | 0                 | success | published       | yes |
 * | 2                 | warning | published       | yes |
 * | other, or timeout | failure | withdrawn       | no  |
 */
import { describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { BlockId } from "@runbooks/blocks-core/contract"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import { type EnvSession, type UseEnvSession, withEnvSession } from "../test-utils/envSessions.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"
import { makeTestSpawner } from "../test-utils/TestSpawner.ts"

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)

const withSession = <A>(
  runbook: string,
  use: UseEnvSession<A>,
  processEnvironment: Readonly<Record<string, string>> = {},
): Promise<A> =>
  withEnvSession(
    {
      file: RUNBOOK,
      workingFolders: "/work",
      processEnvironment,
      fileSystem: makeTestFileSystem({ [RUNBOOK]: runbook }),
      spawner: makeTestSpawner(),
    },
    use,
  )

/** A script block that writes an output and a variable, then ends as `ends` says, run by run. */
const writer = (ends: string) =>
  `<Script id="w" label="w" writesOutput={["region=us-east-1"]} writesEnv={["X=1"]} declares={["region"]} ends={${ends}} />`

/** Blocks after the writer: one that depends on it, one that takes its environment. */
const AFTER = [
  '<Run id="next" command="next" dependsOn={["w"]} />',
  '<Run id="reader" command="reader" envFrom={["w"]} />',
].join("\n\n")

const runbookOf = (ends: string) => `${writer(ends)}\n\n${AFTER}`

const waitingFor = (capability: "run" | "env"): BlockStatus => ({
  _tag: "Blocked",
  by: [{ _tag: "WaitingFor", block: blockId("w"), capability }],
})

const PUBLISHED = { w: { region: { _tag: "Shown", value: "us-east-1" } } } as const

/** What a run that ended well leaves: its outputs published, the blocks after it free to run with its env. */
const expectKept = (rb: EnvSession) =>
  Effect.gen(function* () {
    expect(yield* rb.outputs).toEqual(PUBLISHED)
    expect(yield* rb.status("next")).toEqual({ _tag: "Idle" })
    expect(yield* rb.run("reader")).toEqual({ _tag: "Done", outcome: "success" })
    expect(rb.envOf("reader")).toEqual({ X: "1" })
  })

/** What a run that did not end well leaves: nothing published, and the blocks after it waiting. */
const expectWithdrawn = (rb: EnvSession) =>
  Effect.gen(function* () {
    expect(yield* rb.outputs).toEqual({})
    expect(yield* rb.status("next")).toEqual(waitingFor("run"))
    expect(yield* rb.status("reader")).toEqual(waitingFor("env"))
  })

describe("the exit-code table, in a session", () => {
  it("emits success status for exit code 0", async () => {
    await withSession(runbookOf("[0]"), (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.run("w")).toEqual({ _tag: "Done", outcome: "success" })
        yield* expectKept(rb)
      }),
    )
  })

  it("emits warn status for exit code 2", async () => {
    await withSession(runbookOf("[2]"), (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.run("w")).toEqual({ _tag: "Done", outcome: "warning" })
        yield* expectKept(rb)
      }),
    )
  })

  it("emits fail status for non-zero exit code", async () => {
    for (const exitCode of [1, 3, 126, 127, 255])
      await withSession(runbookOf(`[${exitCode}]`), (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.run("w")).toMatchObject({
            _tag: "Failed",
            error: { _tag: "TaskFailed", exitCode },
          })
          yield* expectWithdrawn(rb)
        }),
      )
  })

  it("does not emit outputs on failure", async () => {
    await withSession(runbookOf("[0, 1]"), (rb) =>
      Effect.gen(function* () {
        yield* rb.run("w")
        expect(yield* rb.outputs).toEqual(PUBLISHED)
        expect((yield* rb.run("w"))?._tag).toBe("Failed")
        yield* expectWithdrawn(rb)
      }),
    )
  })
})

describe("a run that does not end", () => {
  it("withdraws its outputs and env when it times out", async () => {
    await withSession(runbookOf('[0, "timeout"]'), (rb) =>
      Effect.gen(function* () {
        yield* rb.run("w")
        expect(yield* rb.outputs).toEqual(PUBLISHED)
        expect(yield* rb.run("w")).toMatchObject({
          _tag: "Failed",
          error: { _tag: "TaskTimedOut" },
        })
        yield* expectWithdrawn(rb)
      }),
    )
  })

  it("withdraws its outputs and env when it is stopped, after its script wrote them", async () => {
    await withSession(runbookOf('[0, "never"]'), (rb) =>
      Effect.gen(function* () {
        yield* rb.run("w")
        expect(yield* rb.outputs).toEqual(PUBLISHED)
        yield* rb.start("w")
        while (rb.wrote("w") < 2) yield* Effect.sleep("1 millis")
        expect(yield* rb.stop("w")).toMatchObject({
          _tag: "Failed",
          error: { _tag: "TaskCancelled" },
        })
        yield* expectWithdrawn(rb)
      }),
    )
  })
})

describe("what a script writes", () => {
  it("fails its run when a line cannot be read, keeping none of what it wrote", async () => {
    const runbook = [
      '<Script id="w" label="w" writesOutput={["region=us-east-1"]} writesEnv={["X=1", "not a line"]} declares={["region"]} />',
      AFTER,
    ].join("\n\n")
    await withSession(runbook, (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.run("w")).toMatchObject({
          _tag: "Failed",
          error: {
            _tag: "TaskFailed",
            message:
              "The script wrote what Runbooks cannot read, so the run failed.\n$RUNBOOK_ENV line 2: not NAME=value or NAME<<DELIMITER.",
          },
        })
        yield* expectWithdrawn(rb)
      }),
    )
  })

  it("hides an output the script marks sensitive, as one the block declares sensitive", async () => {
    const runbook =
      '<Script id="w" label="w" writesOutput={["sensitive:token=t0k3n", "secret_key=k3y", "plain=p"]} declares={["token", "secret_key", "plain"]} />'
    await withSession(runbook, (rb) =>
      Effect.gen(function* () {
        yield* rb.run("w")
        expect(yield* rb.outputs).toEqual({
          w: {
            token: { _tag: "Hidden" },
            secret_key: { _tag: "Hidden" },
            plain: { _tag: "Shown", value: "p" },
          },
        })
      }),
    )
  })

  it("keeps only the outputs its block declares", async () => {
    const runbook =
      '<Script id="w" label="w" writesOutput={["region=us-east-1", "undeclared=x"]} declares={["region"]} />'
    await withSession(runbook, (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.run("w")).toEqual({ _tag: "Done", outcome: "success" })
        expect(yield* rb.outputs).toEqual(PUBLISHED)
      }),
    )
  })

  it("never shows a value from $RUNBOOK_ENV, $RUNBOOK_OUTPUT or the base environment in an event", async () => {
    const runbook = [
      '<Script id="ok" label="ok" writesOutput={["sensitive:token=secret-output"]} writesEnv={["X=secret-env"]} declares={["token"]} />',
      '<Script id="bad" label="bad" writesOutput={["secret-output-line"]} writesEnv={["bad-name=secret-env-line", "K<<EOF", "secret-heredoc"]} />',
      '<Run id="reader" command="reader" envFrom={["ok"]} />',
    ].join("\n\n")
    const events = await withSession(
      runbook,
      (rb) =>
        Effect.gen(function* () {
          yield* rb.run("ok")
          yield* rb.run("bad")
          yield* rb.run("reader")
          return yield* rb.close
        }),
      { BASE: "secret-base" },
    )
    expect(JSON.stringify(events)).not.toContain("secret")
  })
})
