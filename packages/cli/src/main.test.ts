import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tempFolder } from "./test-utils/runCliForTest.ts"

// The `runbooks` binary as a person runs it, over the registry it ships
// with and the Node layers: `runbooks test` runs a runbook's scripts with no
// window. It gets PATH from this process's environment and nothing else, a
// home folder of its own, and no bun cache, so the test sees what it writes.
//
// The fixture is Command's end-to-end runbook. Each of its steps checks
// something Command promises (outputs, envFrom, {{ }} values, the run's
// folder, the log helpers, a failing exit code), so a Command that breaks
// one fails this test.

const MAIN = path.join(import.meta.dirname, "main.ts")
const FIXTURE = path.resolve(import.meta.dirname, "../../../blocks/command/testdata/end-to-end")

let folder: ReturnType<typeof tempFolder>

beforeEach(() => {
  folder = tempFolder()
})

afterEach(() => {
  folder.remove()
})

describe("runbooks test", () => {
  /** Runs `runbooks test` on a copy of the fixture, its test file `testFile` if given. */
  const runTest = (testFile?: string) => {
    const runbook = path.join(folder.path, "end-to-end")
    const home = path.join(folder.path, "home")
    cpSync(FIXTURE, runbook, { recursive: true })
    if (testFile !== undefined) writeFileSync(path.join(runbook, "runbook_test.yml"), testFile)
    mkdirSync(home)
    const ran = spawnSync(process.execPath, [MAIN, "test", runbook], {
      env: { PATH: process.env["PATH"], HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      encoding: "utf8",
      timeout: 60_000,
    })
    return { ran, runbook, home }
  }

  it("runs a runbook's scripts with no window, from a copy of it, and exits 0 when its tests pass", () => {
    const { ran, runbook, home } = runTest()
    expect(ran.stdout).toContain("✓ end-to-end")
    expect(ran.stdout).toContain("Results: 1 passed, 0 failed, 0 skipped")
    expect(ran.status).toBe(0)
    // The scripts ran in the run's folder: nothing was written beside the runbook.
    expect(readdirSync(runbook).sort()).toEqual(["runbook.mdx", "runbook_test.yml", "scripts"])
    expect(readdirSync(home)).toEqual([])
  })

  it("exits 1 when a test fails, saying which step", () => {
    const { ran } = runTest(
      "version: 1\ntests:\n  - name: wrong\n    steps:\n      - block: fails\n        expect: success\n",
    )
    expect(ran.stdout).toContain("✗ wrong")
    expect(ran.stdout).toContain("fails")
    expect(ran.stdout).toContain("Results: 0 passed, 1 failed, 0 skipped")
    expect(ran.status).toBe(1)
  })
})
