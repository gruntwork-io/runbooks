import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"

// Inputs' testdata through the `runbooks test` entry point, as an author
// runs it: the real registry, a real bash, the real file system. Each
// folder's runbook_test.yml says what its forms give their readers. The
// test runs with only PATH from this process's environment, and a home and
// a temporary folder of its own.

const MAIN = nodePath.resolve(import.meta.dirname, "../../packages/cli/src/main.ts")
const TESTDATA = nodePath.join(import.meta.dirname, "testdata")

const runbooksTest = (runbook: string) => {
  const folder = nodeFs.realpathSync(
    nodeFs.mkdtempSync(nodeFs.realpathSync(os.tmpdir()) + "/runbooks-inputs-cli-"),
  )
  try {
    const ran = spawnSync(
      "/bin/bash",
      [
        "-c",
        'exec env -i PATH="$PATH" HOME="$1" TMPDIR="$1" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun "$2" test "$3"',
        "-",
        folder,
        MAIN,
        runbook,
      ],
      { encoding: "utf8", timeout: 60_000 },
    )
    return { code: ran.status, out: ran.stdout + ran.stderr }
  } finally {
    nodeFs.rmSync(folder, { recursive: true, force: true })
  }
}

describe("runbooks test, on Inputs' testdata", () => {
  it("finds the three runbooks", () => {
    expect(nodeFs.readdirSync(TESTDATA).sort()).toEqual(["end-to-end", "path", "prefilled"])
  })

  for (const name of ["end-to-end", "path", "prefilled"])
    it(`passes ${name}`, () => {
      const { code, out } = runbooksTest(nodePath.join(TESTDATA, name))
      expect(out).toContain("Results: 1 passed, 0 failed, 0 skipped")
      expect(code).toBe(0)
    })
})
