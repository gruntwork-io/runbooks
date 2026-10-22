/**
 * The check with the real spawner and real bash, against fake tools in a temp
 * directory: what a tool counts as installed is bash's call, so a stub
 * spawner would test nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect, Layer, Stream } from "effect"
import { ChildProcessSpawnerLive } from "../../layers/ChildProcessSpawner.ts"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { PathRefreshError } from "../../errors/index.ts"
import type { ExecEvent } from "../exec/executor.ts"
import { checkPrerequisites, executePrerequisites, type FreshPath } from "./check.ts"
import { parsePrerequisitesSpec, type PrerequisitesSpec } from "./spec.ts"

let tmpDir = ""
let binDir = ""
let lateBinDir = ""
let sessionPath = ""

const layer = Layer.mergeAll(ChildProcessSpawnerLive, NodeFileSystemLive, makeTestEnvironment())

function run<A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(layer)))
}

/** Write an executable shell script called `name` into `dir`. */
function writeTool(dir: string, name: string, body: string, mode = 0o755): void {
  fs.writeFileSync(nodePath.join(dir, name), `#!/bin/sh\n${body}\n`, { mode })
}

function spec(yaml: string): PrerequisitesSpec {
  const parsed = parsePrerequisitesSpec(yaml)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.spec
}

function session(path = sessionPath) {
  return { env: { PATH: path }, workDir: tmpDir }
}

beforeAll(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-prereqs-")))
  binDir = nodePath.join(tmpDir, "bin")
  lateBinDir = nodePath.join(tmpDir, "late-bin")
  fs.mkdirSync(binDir)
  fs.mkdirSync(lateBinDir)
  writeTool(binDir, "fake-tofu", 'echo "OpenTofu v1.8.2"; echo "on darwin_arm64"')
  writeTool(binDir, "stderr-tool", 'echo "stderr-tool version 0.9.0" >&2')
  writeTool(binDir, "args-tool", 'echo "args: $*"; [ "$1 $2" = "version --client" ] && echo 3.1.4')
  writeTool(binDir, "quiet-tool", "exit 3")
  writeTool(binDir, "not-executable", "echo 1.0.0", 0o644)
  writeTool(lateBinDir, "late-tool", "echo late-tool 2.0.0")
  // bash itself has to stay findable, as on any real PATH
  sessionPath = `${binDir}:/usr/bin:/bin`
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("checkPrerequisites", () => {
  it("finds the tools on the session's PATH and reads the versions it's asked to", async () => {
    const { results, log } = await run(
      checkPrerequisites(
        spec(`
tools:
  - fake-tofu
  - name: stderr-tool
    version: ">= 0.9"
  - name: args-tool
    versionArgs: [version, --client]
`),
        session(),
      ),
    )

    expect(
      results.map(({ tool, status, path, version }) => [tool.name, status, path, version]),
    ).toEqual([
      ["fake-tofu", "found", `${binDir}/fake-tofu`, null],
      // Read from stderr: some tools print their version there
      ["stderr-tool", "found", `${binDir}/stderr-tool`, "0.9.0"],
      ["args-tool", "found", `${binDir}/args-tool`, "3.1.4"],
    ])
    expect(log.at(-1)).toEqual({ level: "INFO", text: "All 3 tools are installed." })
  })

  it("only counts an executable file on PATH", async () => {
    const { results } = await run(
      checkPrerequisites(spec("tools:\n  - not-executable\n  - no-such-tool\n"), session()),
    )
    expect(results.map((result) => result.status)).toEqual(["missing", "missing"])
  })

  it("checks a version constraint, and quotes the output it couldn't read a version from", async () => {
    const { results, log } = await run(
      checkPrerequisites(
        spec(`
tools:
  - name: fake-tofu
    version: ">= 1.9"
  - name: quiet-tool
    version: ">= 1"
  - name: args-tool
    version: ">= 1"
`),
        session(),
      ),
    )

    expect(results.map((result) => result.status)).toEqual([
      "wrong_version",
      "unknown_version",
      "unknown_version",
    ])
    expect(log).toContainEqual({
      level: "WARN",
      text: '"quiet-tool --version" printed nothing (exit code 3).',
    })
    expect(log).toContainEqual({
      level: "WARN",
      text: '"args-tool --version" printed: args: --version',
    })
  })

  describe("when a tool isn't on PATH", () => {
    const fresh = (entries: string[]): Effect.Effect<FreshPath, PathRefreshError> =>
      Effect.succeed({ source: "your login shell (/bin/fake)", entries })

    it("reads PATH again, adds what's new, and finds the tool there", async () => {
      const { results, log } = await run(
        checkPrerequisites(
          spec("tools:\n  - fake-tofu\n  - late-tool\n"),
          session(),
          fresh([binDir, lateBinDir, "/usr/bin"]),
        ),
      )

      expect(results.map((result) => [result.status, result.path])).toEqual([
        ["found", `${binDir}/fake-tofu`],
        ["found", `${lateBinDir}/late-tool`],
      ])
      expect(log[0]).toEqual({
        level: "INFO",
        text: `late-tool wasn't on PATH, so Runbooks read PATH again from your login shell (/bin/fake) and added ${lateBinDir}.`,
      })
    })

    it("says so when the PATH it reads again has nothing new", async () => {
      const { results, log } = await run(
        checkPrerequisites(
          spec("tools:\n  - late-tool\n  - other-tool\n"),
          session(),
          fresh([binDir]),
        ),
      )

      expect(results.map((result) => result.status)).toEqual(["missing", "missing"])
      expect(log[0]).toEqual({
        level: "INFO",
        text: "late-tool, other-tool weren't on PATH, so Runbooks read PATH again from your login shell (/bin/fake). It has no directories that weren't on PATH already.",
      })
    })

    it("warns when PATH can't be read again", async () => {
      const { results, log } = await run(
        checkPrerequisites(
          spec("tools:\n  - late-tool\n"),
          session(),
          Effect.fail(new PathRefreshError({ message: "SHELL isn't set." })),
        ),
      )

      expect(results[0]!.status).toBe("missing")
      expect(log[0]).toEqual({
        level: "WARN",
        text: "late-tool wasn't on PATH, and PATH couldn't be read again: SHELL isn't set.",
      })
    })

    it("doesn't read PATH again when every tool is found", async () => {
      let reads = 0
      const counted = Effect.sync(() => reads++).pipe(Effect.andThen(fresh([lateBinDir])))

      await run(checkPrerequisites(spec("tools:\n  - fake-tofu\n"), session(), counted))

      expect(reads).toBe(0)
    })

    it("doesn't read PATH again for a tool another of its anyOf list stands in for", async () => {
      let reads = 0
      const counted = Effect.sync(() => reads++).pipe(Effect.andThen(fresh([lateBinDir])))

      const { results, log } = await run(
        checkPrerequisites(spec("tools:\n  - anyOf: [fake-tofu, late-tool]\n"), session(), counted),
      )

      expect(reads).toBe(0)
      expect(results.map((result) => result.status)).toEqual(["found", "missing"])
      expect(log).toContainEqual({
        level: "INFO",
        text: "late-tool: not found on PATH. fake-tofu is installed instead.",
      })
    })

    it("reads PATH again when no tool of an anyOf list is found, and reads the version of the one found there", async () => {
      const { results, log } = await run(
        checkPrerequisites(
          spec(
            'tools:\n  - anyOf:\n      - no-such-tool\n      - name: late-tool\n        version: ">= 2"\n',
          ),
          session(),
          fresh([lateBinDir]),
        ),
      )

      expect(results.map((result) => [result.status, result.version])).toEqual([
        ["missing", null],
        ["found", "2.0.0"],
      ])
      expect(log[0]).toEqual({
        level: "INFO",
        text: `no-such-tool, late-tool weren't on PATH, so Runbooks read PATH again from your login shell (/bin/fake) and added ${lateBinDir}.`,
      })
    })

    it("reads PATH again for an anyOf list whose only tool on PATH is too old", async () => {
      const { results, log } = await run(
        checkPrerequisites(
          spec(
            'tools:\n  - anyOf:\n      - name: fake-tofu\n        version: ">= 2"\n      - late-tool\n',
          ),
          session(),
          fresh([lateBinDir]),
        ),
      )

      expect(results.map((result) => result.status)).toEqual(["wrong_version", "found"])
      expect(log[0]!.text).toStartWith("late-tool wasn't on PATH, so Runbooks read PATH again")
    })
  })
})

describe("executePrerequisites", () => {
  async function execute(yaml: string, path = sessionPath) {
    const logsDir = nodePath.join(tmpDir, "logs", String(Math.random()).slice(2))
    return run(
      Effect.gen(function* () {
        const { logStream, completionEffect, logFilePath } = yield* executePrerequisites(
          yaml,
          session(path),
          logsDir,
        )
        const streamed = yield* Stream.runCollect(logStream)
        const events: ExecEvent[] = [...streamed, ...(yield* completionEffect)]
        return { events, logFile: fs.readFileSync(logFilePath, "utf8") }
      }),
    )
  }

  const lines = (events: ExecEvent[]) =>
    events.flatMap((event) => (event._tag === "log" ? [event.event.line] : []))

  it("reports a run like a script's: log lines, a status and outputs, with the log in its file", async () => {
    const { events, logFile } = await execute(
      "tools:\n  - fake-tofu\n  - name: gh-x\n    optional: true\n",
    )

    expect(lines(events)).toEqual([
      expect.stringMatching(/^\[[\dTZ:-]+\] \[INFO\]  fake-tofu: found at .*\/bin\/fake-tofu$/),
      expect.stringMatching(/\[WARN\]  gh-x: not found on PATH\. This tool is optional\.$/),
      expect.stringMatching(/\[WARN\]  The required tools are installed\./),
    ])
    expect(events.filter((event) => event._tag !== "log")).toEqual([
      { _tag: "status", event: { status: "warn", exitCode: 2 } },
      {
        _tag: "outputs",
        event: { outputs: { fake_tofu_path: `${binDir}/fake-tofu`, gh_x_path: "" } },
      },
      { _tag: "done" },
    ])
    expect(logFile).toBe(
      lines(events)
        .map((line) => `${line}\n`)
        .join(""),
    )
  })

  it("publishes outputs for a failed check too, since they say what was found", async () => {
    const { events } = await execute("tools:\n  - fake-tofu\n  - no-such-tool\n")

    expect(events).toContainEqual({ _tag: "status", event: { status: "fail", exitCode: 1 } })
    expect(events).toContainEqual({
      _tag: "outputs",
      event: { outputs: { fake_tofu_path: `${binDir}/fake-tofu`, no_such_tool_path: "" } },
    })
  })

  it("fails with the tool list's error when it doesn't parse", async () => {
    const { events } = await execute("tools: []\n")

    expect(lines(events)).toEqual([
      expect.stringContaining("[ERROR] `tools:` must be a list with at least one tool."),
    ])
    expect(events).toContainEqual({ _tag: "status", event: { status: "fail", exitCode: 1 } })
    expect(events.some((event) => event._tag === "outputs")).toBe(false)
  })

  it("fails, saying why, when bash can't run", async () => {
    const { events } = await execute("tools:\n  - fake-tofu\n", nodePath.join(tmpDir, "empty"))

    expect(lines(events)).toEqual([
      expect.stringContaining("[ERROR] Couldn't look for the tools on PATH: bash couldn't run"),
    ])
    expect(events).toContainEqual({ _tag: "status", event: { status: "fail", exitCode: 1 } })
  })
})
