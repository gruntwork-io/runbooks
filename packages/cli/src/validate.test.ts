import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { FileReadError } from "@runbooks/core/errors"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { TOY_REGISTRY } from "@runbooks/core/test-utils/toyRegistry"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { EXIT, ValidateReport } from "./contract.ts"
import { MAX_WALKED_ENTRIES } from "./runbookPaths.ts"
import { runCliForTest, tempFolder } from "./test-utils/runCliForTest.ts"

let folder: ReturnType<typeof tempFolder>
beforeEach(() => {
  folder = tempFolder()
})
afterEach(() => folder.remove())

/** Writes `runbook.mdx` in `dir` (relative to the test's folder) and gives its absolute path. */
function runbook(dir: string, source: string): string {
  const at = path.join(folder.path, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(path.join(at, "runbook.mdx"), source)
  return path.join(at, "runbook.mdx")
}

const validate = (argv: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  runCliForTest(["validate", ...argv], { registry: TOY_REGISTRY, cwd: folder.path, env })

const decodeReport = (stdout: string) =>
  Schema.decodeUnknownSync(ValidateReport)(JSON.parse(stdout))

const GOOD = '# Deploy\n\n<Run id="deploy" command="make deploy" />\n'
/** Line 3: `args` is not a list of strings. */
const BAD_PROP = '# Deploy\n\n<Run id="deploy" args="--force" />\n'

describe("runbooks validate", () => {
  it("passes a valid runbook, and says so", async () => {
    runbook("good", GOOD)
    const run = await validate(["good"])
    expect(run.code).toBe(EXIT.success)
    expect(run.stdout).toContain("good/runbook.mdx: valid")
    expect(run.stderr).toBe("")
  })

  it("prints each configuration error at its line and column, and fails", async () => {
    runbook("bad", BAD_PROP)
    const run = await validate(["bad/runbook.mdx"])
    expect(run.code).toBe(EXIT.failure)
    expect(run.stdout).toMatch(/^bad\/runbook\.mdx:3:\d+: error badProp: .*`args`/m)
    expect(run.stdout).toMatch(/^ {4}received: text$/m)
    expect(run.stdout).not.toContain("--force")
  })

  it("prints what was expected and what it likely meant", async () => {
    runbook("typo", '<Runn id="a" />\n\n<Run id="b" comand="make" />\n')
    const run = await validate(["typo"])
    expect(run.code).toBe(EXIT.failure)
    expect(run.stdout).toMatch(
      /^typo\/runbook\.mdx:1:1: error unknownBlock: [^\n]*\n {4}did you mean: <Run>$/m,
    )
    expect(run.stdout).toMatch(
      /^typo\/runbook\.mdx:3:\d+: warning unknownProp: [^\n]*\n {4}did you mean: command$/m,
    )
    expect(run.stdout).toContain("1 checked: 0 valid, 1 invalid.")
  })

  it("reports every runbook in json, errors with their codes and lines, and warnings apart", async () => {
    runbook("good", GOOD)
    runbook("bad", BAD_PROP)
    runbook("warned", '<Run id="deploy" command="make" colour="blue" />\n')
    const run = await validate(["good", "bad", "warned", "--output", "json"])
    expect(run.code).toBe(EXIT.failure)
    const report = decodeReport(run.stdout)
    expect(report.outcome).toBe("invalid")
    expect(report.failure).toBeUndefined()
    const byFolder = Object.fromEntries(
      report.runbooks.map((r) => [path.basename(path.dirname(r.path)), r]),
    )
    expect(byFolder.good?.errors).toEqual([])
    expect(byFolder.bad?.errors.map((e) => [e.code, e.location.span.start.line])).toEqual([
      ["badProp", 3],
    ])
    expect(byFolder.warned?.errors).toEqual([])
    expect(byFolder.warned?.warnings.map((w) => [w.code, w.location.prop])).toEqual([
      ["unknownProp", "colour"],
    ])
  })

  it("names a block the registry does not have, which refuses the runbook", async () => {
    runbook("unknown", '<Run id="a" command="x" />\n\n<Deploy id="b" />\n')
    const run = await validate(["unknown", "--output", "json"])
    expect(run.code).toBe(EXIT.failure)
    const [checked] = decodeReport(run.stdout).runbooks
    expect(checked?.errors.map((e) => [e.code, e.location.span.start.line])).toEqual([
      ["unknownBlock", 3],
    ])
  })

  it("passes a runbook that only warns", async () => {
    runbook("warned", '<Run id="deploy" command="make" colour="blue" />\n')
    const run = await validate(["warned"])
    expect(run.code).toBe(EXIT.success)
    expect(run.stdout).toMatch(/warned\/runbook\.mdx:1:\d+: warning unknownProp: /)
  })

  it("takes every runbook under a folder ending in /..., but not under node_modules or a hidden folder", async () => {
    runbook("runbooks/a", GOOD)
    runbook("runbooks/b/c", GOOD)
    runbook("runbooks/node_modules/pkg", BAD_PROP)
    runbook("runbooks/.cache", BAD_PROP)
    const run = await validate(["runbooks/...", "--output", "json"])
    expect(run.code).toBe(EXIT.success)
    expect(
      decodeReport(run.stdout).runbooks.map((r) => path.relative(folder.path, r.path)),
    ).toEqual(["runbooks/a/runbook.mdx", "runbooks/b/c/runbook.mdx"])
  })

  it("validates a runbook named twice once", async () => {
    runbook("good", GOOD)
    const run = await validate(["good", "good/runbook.mdx", "./...", "--output", "json"])
    expect(decodeReport(run.stdout).runbooks).toHaveLength(1)
  })

  it("fails a path that names nothing, writing the failure in the report and on stderr", async () => {
    runbook("good", GOOD)
    const run = await validate(["good", "missing", "--output", "json"])
    expect(run.code).toBe(EXIT.failure)
    const report = decodeReport(run.stdout)
    expect(report.failure).toEqual({ _tag: "PathNotFound", path: "missing" })
    expect(report.outcome).toBe("invalid")
    expect(run.stderr).toContain("missing")
  })

  it("fails a folder with no runbook in it", async () => {
    mkdirSync(path.join(folder.path, "empty"))
    const folderRun = await validate(["empty", "--output", "json"])
    expect(decodeReport(folderRun.stdout).failure).toEqual({
      _tag: "PathNotFound",
      path: path.join(folder.path, "empty", "runbook.mdx"),
    })
    const treeRun = await validate(["empty/...", "--output", "json"])
    expect(treeRun.code).toBe(EXIT.failure)
    expect(decodeReport(treeRun.stdout).failure).toEqual({
      _tag: "NoRunbooks",
      patterns: ["empty/..."],
    })
  })

  it("stops at a folder that holds more entries than it looks through", async () => {
    runbook("big/a", GOOD)
    const big = path.join(folder.path, "big")
    const many = Array.from({ length: MAX_WALKED_ENTRIES + 1 }, (_, i) => ({
      name: `file-${i}`,
      isFile: true,
      isDirectory: false,
    }))
    const fileSystem = Layer.effect(
      FileSystem,
      Effect.gen(function* () {
        const real = yield* FileSystem
        return {
          ...real,
          readdirWithTypes: (dir: string) =>
            dir === big ? Effect.succeed(many) : real.readdirWithTypes(dir),
        }
      }),
    ).pipe(Layer.provide(NodeFileSystemLive))
    const run = await runCliForTest(["validate", "big/...", "--output", "json"], {
      registry: TOY_REGISTRY,
      cwd: folder.path,
      fileSystem,
    })
    expect(run.code).toBe(EXIT.failure)
    expect(decodeReport(run.stdout).failure).toEqual({
      _tag: "TooManyFiles",
      path: "big/...",
      limit: MAX_WALKED_ENTRIES,
    })
  })

  it("fails a runbook it cannot read, keeping those it checked before", async () => {
    const good = runbook("a", GOOD)
    const locked = runbook("b", GOOD)
    const fileSystem = Layer.effect(
      FileSystem,
      Effect.gen(function* () {
        const real = yield* FileSystem
        return {
          ...real,
          readFile: (file: string) =>
            file === locked
              ? Effect.fail(
                  new FileReadError({ path: file, cause: new Error("permission denied") }),
                )
              : real.readFile(file),
        }
      }),
    ).pipe(Layer.provide(NodeFileSystemLive))
    const run = await runCliForTest(["validate", "a", "b", "--output", "json"], {
      registry: TOY_REGISTRY,
      cwd: folder.path,
      fileSystem,
    })
    expect(run.code).toBe(EXIT.failure)
    const report = decodeReport(run.stdout)
    expect(report.runbooks.map((r) => r.path)).toEqual([good])
    expect(report.failure).toEqual({
      _tag: "Unreadable",
      path: locked,
      message: "permission denied",
    })
  })

  it("reads RUNBOOKS_OUTPUT, and a flag wins over it", async () => {
    runbook("good", GOOD)
    const json = await validate(["good"], { RUNBOOKS_OUTPUT: "json" })
    expect(decodeReport(json.stdout).outcome).toBe("valid")
    const text = await validate(["good", "--output", "text"], { RUNBOOKS_OUTPUT: "json" })
    expect(text.stdout).toContain("good/runbook.mdx: valid")
  })

  it("writes text when RUNBOOKS_OUTPUT is junit, which is for runbooks test, as CI sets it for both", async () => {
    runbook("good", GOOD)
    const run = await validate(["good"], { RUNBOOKS_OUTPUT: "junit" })
    expect(run.code).toBe(EXIT.success)
    expect(run.stdout).toContain("good/runbook.mdx: valid")
  })

  it("still refuses a RUNBOOKS_OUTPUT no command writes", async () => {
    runbook("good", GOOD)
    const run = await validate(["good"], { RUNBOOKS_OUTPUT: "xml" })
    expect(run.code).toBe(EXIT.failure)
    expect(run.stdout).toBe("")
  })
})

describe("the runbooks command line", () => {
  it("refuses an --output it does not know, with nothing on stdout", async () => {
    const run = await validate(["good", "--output", "junit"])
    expect(run.code).toBe(EXIT.failure)
    expect(run.stdout).toBe("")
    expect(run.stderr).toContain("--output")
  })

  it("still writes the json report when it refuses another flag", async () => {
    const run = await runCliForTest(["test", "./x", "--max-parallel", "0", "--output", "json"], {
      registry: TOY_REGISTRY,
      cwd: folder.path,
    })
    expect(run.code).toBe(EXIT.failure)
    const report: unknown = JSON.parse(run.stdout)
    expect(report).toMatchObject({
      version: 1,
      outcome: "failed",
      failure: { _tag: "BadFlag", flag: "--max-parallel" },
    })
  })

  it("prints help a person asks for on stdout", async () => {
    const run = await runCliForTest(["validate", "--help"], {
      registry: TOY_REGISTRY,
      cwd: folder.path,
    })
    expect(run.code).toBe(EXIT.success)
    expect(run.stdout).toContain("--output")
  })

  it("fails open and mcp, which are not built yet", async () => {
    for (const command of ["open", "mcp"]) {
      const run = await runCliForTest([command], { registry: TOY_REGISTRY, cwd: folder.path })
      expect(run.code).toBe(EXIT.failure)
      expect(run.stderr).toContain(`runbooks ${command} is not built yet`)
    }
  })
})
