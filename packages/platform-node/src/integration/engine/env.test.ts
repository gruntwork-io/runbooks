import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect } from "effect"
import { withEnvSession } from "@runbooks/core/test-utils/envSessions"
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

const withShell = <A>(
  script: string,
  processEnvironment: Readonly<Record<string, string>>,
  check: (printed: ReadonlyArray<string>) => A,
) => {
  const file = nodePath.join(root, "rb", "runbook.mdx")
  nodeFs.writeFileSync(file, `<Shell id="s" label="s" script={${JSON.stringify(script)}} />`)
  return withEnvSession(
    {
      file,
      workingFolders: nodePath.join(root, "work"),
      processEnvironment,
      fileSystem: NodeFileSystemLive,
      spawner: ChildProcessSpawnerLive,
    },
    (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.run("s")).toEqual({ _tag: "Done", outcome: "success" })
        return check(rb.printedBy("s") ?? [])
      }),
  )
}

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
    const names = ["PATH", "KEPT", "GITHUB_TOKEN", "GITLAB_TOKEN", "RUNBOOK_OUTPUT", "HOME", "USER"]
    const app = {
      PATH: "/usr/bin:/bin",
      KEPT: "kept",
      GITHUB_TOKEN: "ghp_ambient",
      GITLAB_TOKEN: "glpat_ambient",
      RUNBOOK_OUTPUT: "/outer/output",
    }
    await withShell(printing(names), app, (printed) => {
      expect(printed).toEqual([
        base64("/usr/bin:/bin"),
        base64("kept"),
        ...Array.from({ length: 5 }, () => base64("<unset>")),
      ])
    })
  })
})
