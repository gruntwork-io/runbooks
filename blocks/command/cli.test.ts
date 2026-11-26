import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"

// Command with a real bash, the real file system and the real engine, through
// the `runbooks test` entry point, as an author runs it: no window. The
// command runs with only PATH from this process's environment, a home
// folder of its own, and no bun cache, so the test sees whether it wrote there.

const MAIN = nodePath.resolve(import.meta.dirname, "../../packages/cli/src/main.ts")
const folder = nodeFs.realpathSync(
  nodeFs.mkdtempSync(nodeFs.realpathSync(os.tmpdir()) + "/runbooks-command-cli-"),
)
afterAll(() => nodeFs.rmSync(folder, { recursive: true, force: true }))

/** `runbooks test` on a runbook folder holding `files`. */
const runbooksTest = (name: string, files: Record<string, string>) => {
  const runbook = nodePath.join(folder, name)
  for (const [file, text] of Object.entries(files)) {
    nodeFs.mkdirSync(nodePath.dirname(nodePath.join(runbook, file)), { recursive: true })
    nodeFs.writeFileSync(nodePath.join(runbook, file), text)
  }
  const home = nodeFs.mkdtempSync(nodePath.join(folder, "home-"))
  const ran = spawnSync(
    "/bin/bash",
    [
      "-c",
      'exec env -i PATH="$PATH" HOME="$1" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun "$2" test "$3"',
      "-",
      home,
      MAIN,
      runbook,
    ],
    { encoding: "utf8", timeout: 60_000 },
  )
  return { code: ran.status, out: ran.stdout + ran.stderr, home }
}

/** A value that runs a command, splits and globs, if bash reads it as code. */
const HOSTILE = "it's $(touch pwned) * `touch pwned`"

const TEST_FILE = `version: 1
tests:
  - name: commands
    steps:
      - block: make
        expect: success
        assertions:
          - type: output_equals
            block: make
            output: value
            value: ${JSON.stringify(HOSTILE)}
      - block: use
        expect: warn
      - block: fails
        expect: fail
`

describe("runbooks test, on a runbook of commands", () => {
  it("runs each with bash, as written: outputs, envFrom, env and exit codes", () => {
    const { code, out, home } = runbooksTest("commands", {
      "runbook.mdx": [
        '<Command id="make" path="scripts/make.sh" outputs={["value"]} />',
        '<Command id="use" path="scripts/use.sh" envFrom={["make"]} env={{ VALUE: "{{ .outputs.make.value }}", COUNT: 2 }} />',
        '<Command id="fails" command="exit 3" />',
      ].join("\n\n"),
      "scripts/make.sh": [
        "#!/bin/bash",
        `printf 'value=%s\\n' ${shellQuoted(HOSTILE)} >> "$RUNBOOK_OUTPUT"`,
        `echo 'FROM_MAKE=made' >> "$RUNBOOK_ENV"`,
        'log_info "made it"',
      ].join("\n"),
      "scripts/use.sh": [
        "#!/bin/bash",
        // Another tool's `{{ }}` reaches bash as written.
        `format='{{.Names}}'; [ "\${#format}" = 10 ] || exit 1`,
        `[ "$VALUE" = ${shellQuoted(HOSTILE)} ] || exit 1`,
        `[ "$COUNT" = 2 ] || exit 1`,
        `[ "$FROM_MAKE" = made ] || exit 1`,
        "[ ! -e pwned ] || exit 1",
        "exit 2",
      ].join("\n"),
      "runbook_test.yml": TEST_FILE,
    })
    expect(out).toContain("✓ commands")
    expect(out).toContain("Results: 1 passed, 0 failed")
    expect(code).toBe(0)
    expect(nodeFs.readdirSync(home)).toEqual([])
  })

  it("fails a step whose script does not end as expected", () => {
    const { code, out } = runbooksTest("failing", {
      "runbook.mdx": '<Command id="c" command="exit 1" />',
      "runbook_test.yml":
        "version: 1\ntests:\n  - name: one\n    steps:\n      - block: c\n        expect: success\n",
    })
    expect(out).toContain("✗ c: fail (expected success")
    expect(code).toBe(1)
  })
})

/** `text` in single quotes, for bash. */
function shellQuoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}
