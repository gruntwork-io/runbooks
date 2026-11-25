import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect } from "effect"
import { type UseEnvSession, withEnvSession } from "@runbooks/core/test-utils/envSessions"
import { ChildProcessSpawnerLive } from "../../layers/ChildProcessSpawner.ts"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"

// A run's environment reaching a real bash, for what only a real shell
// shows. The app's environment is given to the engine, as the entry point
// will; the test's own (its HOME, its USER) never reaches the shell.
let root = ""

beforeEach(() => {
  root = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-env-")))
  nodeFs.mkdirSync(nodePath.join(root, "rb"))
})

afterEach(() => {
  nodeFs.rmSync(root, { recursive: true, force: true })
})

/** Prints each variable's value in base64, so a newline in one cannot pass for a line. */
const printing = (names: ReadonlyArray<string>) =>
  names.map((name) => `printf '%s' "\${${name}-<unset>}" | base64 | tr -d '\\n'; echo`).join("; ")

/** A `Shell` block, its id and label `id`, running `script`. */
const shell = (id: string, script: string, more = "") =>
  `<Shell id="${id}" label="${id}" script={${JSON.stringify(script)}} ${more}/>`

/** A trusted session of `blocks`, on the real filesystem with a real bash. */
const withShells = <A>(
  blocks: ReadonlyArray<string>,
  processEnvironment: Readonly<Record<string, string>>,
  use: UseEnvSession<A>,
) => {
  const file = nodePath.join(root, "rb", "runbook.mdx")
  nodeFs.writeFileSync(file, blocks.join("\n\n"))
  return withEnvSession(
    {
      file,
      workingFolders: nodePath.join(root, "work"),
      processEnvironment,
      fileSystem: NodeFileSystemLive,
      spawner: ChildProcessSpawnerLive,
    },
    use,
  )
}

const done = { _tag: "Done", outcome: "success" } as const

/** What one `Shell` block running `script` printed. */
const withShell = <A>(
  script: string,
  processEnvironment: Readonly<Record<string, string>>,
  check: (printed: ReadonlyArray<string>) => A,
) =>
  withShells([shell("s", script)], processEnvironment, (rb) =>
    Effect.gen(function* () {
      expect(yield* rb.run("s")).toEqual(done)
      return check(rb.printedBy("s") ?? [])
    }),
  )

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64")

describe("a run's environment, in a real shell", () => {
  // Today's src/domain/exec/blockEnv.test.ts guard, by name, which the
  // baseline gate looks for. Nothing quotes a value now: today's values were
  // quoted into a script the shell sourced, and are now handed to the
  // process as its environment, so no shell reads them as code. What the
  // name guards holds: the shell gets each value exactly and runs nothing.
  it("quotes each value so a shell sets it exactly, running nothing", async () => {
    const ran = (name: string) => nodePath.join(root, name)
    const values = {
      SUBSTITUTION: `$(touch ${ran("substitution")})`,
      BACKTICKS: `\`touch ${ran("backticks")}\``,
      SINGLE: `'; touch ${ran("single")}; '`,
      DOUBLE: `"; touch ${ran("double")}; "`,
      NEWLINE: `a\nexport INJECTED=1\ntouch ${ran("newline")}`,
      EXPANSIONS: "$HOME ${PATH} \\ * ? ~ !!",
      UNICODE: "é ✓ 日本",
      EMPTY: "",
    }
    const names = [...Object.keys(values), "INJECTED"]
    await withShell(printing(names), { PATH: "/usr/bin:/bin", ...values }, (printed) => {
      expect(printed).toEqual([...Object.values(values).map(base64), base64("<unset>")])
    })
    for (const name of ["substitution", "backticks", "single", "double", "newline"])
      expect(nodeFs.existsSync(ran(name))).toBe(false)
  })

  it("gives a shell the run's environment and nothing else", async () => {
    const names = [
      "PATH",
      "KEPT",
      "GITHUB_TOKEN",
      "GITLAB_TOKEN",
      "GENERATED_FILES",
      "HOME",
      "USER",
    ]
    const app = {
      PATH: "/usr/bin:/bin",
      KEPT: "kept",
      GITHUB_TOKEN: "ghp_ambient",
      GITLAB_TOKEN: "glpat_ambient",
      GENERATED_FILES: "/outer/files",
      RUNBOOK_OUTPUT: "/outer/output",
    }
    await withShell(`${printing(names)}; echo "$RUNBOOK_OUTPUT"`, app, (printed) => {
      expect(printed.slice(0, -1)).toEqual([
        base64("/usr/bin:/bin"),
        base64("kept"),
        ...Array.from({ length: 5 }, () => base64("<unset>")),
      ])
      // The app's RUNBOOK_OUTPUT is not the run's: the engine's file is.
      expect(printed.at(-1)).toStartWith(nodePath.join(os.tmpdir(), "runbooks-run-"))
    })
  })
})

describe("what a real script writes", () => {
  it("reaches a block that names it, a value with newlines too, and its outputs are published", async () => {
    const writer = [
      `echo "GREETING= hello world" >> "$RUNBOOK_ENV"`,
      `printf 'KEY<<EOF\\nline one\\n  line two\\nEOF\\n' >> "$RUNBOOK_ENV"`,
      `echo "region=us-east-1" >> "$RUNBOOK_OUTPUT"`,
      `echo "sensitive:secret_token=s3cr3t" >> "$RUNBOOK_OUTPUT"`,
    ].join("\n")
    await withShells(
      [
        shell("writer", writer, `declares={["region", "secret_token"]} `),
        shell("reader", printing(["GREETING", "KEY"]), `envFrom={["writer"]} `),
      ],
      { PATH: "/usr/bin:/bin" },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.run("writer")).toEqual(done)
          expect(yield* rb.outputs).toEqual({
            writer: {
              region: { _tag: "Shown", value: "us-east-1" },
              secret_token: { _tag: "Hidden" },
            },
          })
          expect(yield* rb.run("reader")).toEqual(done)
          expect(rb.printedBy("reader")).toEqual([
            base64(" hello world"),
            base64("line one\n  line two"),
          ])
        }),
    )
  })

  it("is kept when the script exits 2, a warning, and the blocks after it run", async () => {
    await withShells(
      [
        shell("warns", `echo "X=1" >> "$RUNBOOK_ENV"; exit 2`),
        shell("after", printing(["X"]), `envFrom={["warns"]} `),
      ],
      { PATH: "/usr/bin:/bin" },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.run("warns")).toEqual({ _tag: "Done", outcome: "warning" })
          expect(yield* rb.run("after")).toEqual(done)
          expect(rb.printedBy("after")).toEqual([base64("1")])
        }),
    )
  })

  it("is dropped when the script exits 1, and its folder goes either way", async () => {
    await withShells(
      [
        shell("fails", `echo "$RUNBOOK_ENV"; echo "X=1" >> "$RUNBOOK_ENV"; exit 1`),
        shell("ok", `echo "$RUNBOOK_ENV"`),
        shell("after", "true", `envFrom={["fails"]} `),
      ],
      { PATH: "/usr/bin:/bin" },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.run("fails")).toMatchObject({
            _tag: "Failed",
            error: { _tag: "TaskFailed", exitCode: 1 },
          })
          expect(yield* rb.status("after")).toMatchObject({ _tag: "Blocked" })
          expect(yield* rb.run("ok")).toEqual(done)
          for (const label of ["fails", "ok"]) {
            const [envFile = ""] = rb.printedBy(label) ?? []
            expect(envFile).toEndWith("/env")
            expect(nodeFs.existsSync(nodePath.dirname(envFile))).toBe(false)
          }
        }),
    )
  })
})
