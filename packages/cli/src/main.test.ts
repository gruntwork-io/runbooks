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
// The fixture is block-id-collisions, as it is in testdata. It has no
// runbook_test.yml there, and the frozen baseline names every fixture that
// has one, so its test file is this one, written beside a copy.

const MAIN = path.join(import.meta.dirname, "main.ts")
const FIXTURE = path.resolve(
  import.meta.dirname,
  "../../../testdata/feature-demos/block-id-collisions",
)

/** Each id's first block runs its script. A later block with that id, as written or normalized, is a configuration error no step can name. */
const FIXTURE_TEST_FILE = `version: 1
settings:
  use_temp_working_dir: true
  timeout: 1m
tests:
  - name: happy-path
    steps:
      - block: my-command
        expect: success
      - block: create-account
        expect: success
      - block: setup-dev
        expect: success
      - block: setup-prod
        expect: success
`

let folder: ReturnType<typeof tempFolder>

beforeEach(() => {
  folder = tempFolder()
})

afterEach(() => {
  folder.remove()
})

describe("runbooks test", () => {
  it("runs a fixture's scripts with no window, from a copy of it in a folder of its own", () => {
    const runbook = path.join(folder.path, "block-id-collisions")
    const home = path.join(folder.path, "home")
    cpSync(FIXTURE, runbook, { recursive: true })
    writeFileSync(path.join(runbook, "runbook_test.yml"), FIXTURE_TEST_FILE)
    mkdirSync(home)
    const ran = spawnSync(process.execPath, [MAIN, "test", runbook], {
      env: { PATH: process.env["PATH"], HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      encoding: "utf8",
      timeout: 60_000,
    })
    expect(ran.stdout).toContain("✓ happy-path")
    expect(ran.stdout).toContain("Results: 1 passed, 0 failed, 0 skipped")
    expect(ran.status).toBe(0)
    expect(readdirSync(runbook).sort()).toEqual(["runbook.mdx", "runbook_test.yml", "scripts"])
    expect(readdirSync(home)).toEqual([])
  })
})
