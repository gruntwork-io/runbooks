import { describe, it, expect } from "bun:test"
import { Effect, Exit } from "effect"
import {
  extractProp,
  extractStringArrayProp,
  computeExecutableId,
  computeComponentId,
  getComponentRegex,
  parseComponents,
  ExecutableRegistry,
} from "./executable.ts"
import { computeContentHash } from "../workspace/file.ts"
import type { FileSystem } from "../../services/FileSystem.ts"
import { makeTestFileSystem } from "../../test-utils/TestFileSystem.ts"

describe("extractProp", () => {
  it("extracts double-quoted value", () => {
    expect(extractProp('id="my-cmd" command="echo hi"', "command")).toBe("echo hi")
  })

  it("extracts single-quoted value", () => {
    expect(extractProp("id='my-cmd'", "id")).toBe("my-cmd")
  })

  it("extracts JSX backtick value", () => {
    expect(extractProp("command={`echo hello`}", "command")).toBe("echo hello")
  })

  it("extracts JSX double-quoted value", () => {
    expect(extractProp('command={"echo hello"}', "command")).toBe("echo hello")
  })

  it("extracts JSX single-quoted value", () => {
    expect(extractProp("command={'echo hello'}", "command")).toBe("echo hello")
  })

  it("returns empty string for missing prop", () => {
    expect(extractProp('id="x"', "command")).toBe("")
  })

  it("extracts JSX boolean value", () => {
    expect(extractProp("generateFile={true}", "generateFile")).toBe("true")
  })

  it("does not read a prop name from inside another prop's value", () => {
    const props =
      'title="Assume role" command={`aws sts assume-role --external-id="{{ .inputs.ExternalId }}"`} id="assume-role"'
    expect(extractProp(props, "id")).toBe("assume-role")
    expect(extractProp('command={`echo id="x"`} id={`real`}', "id")).toBe("real")
    expect(extractProp('id={`real`} command={`aws --external-id="x"`}', "id")).toBe("real")
  })

  it("does not match a prop whose name ends with the requested name", () => {
    expect(extractProp('data-id="foo" id="bar"', "id")).toBe("bar")
    expect(extractProp('inputsId="foo" id="bar"', "id")).toBe("bar")
    expect(extractProp('data-id="foo"', "id")).toBe("")
  })

  it("skips values in unsupported forms", () => {
    expect(extractProp('timeout={300} id="real"', "id")).toBe("real")
    expect(extractProp('timeout={300} id="real"', "timeout")).toBe("")
  })
})

describe("extractStringArrayProp", () => {
  it.each([
    ["double quotes", 'id="p" outputs={["region", "zone"]}', ["region", "zone"]],
    ["mixed quotes and spacing", "outputs={ [ 'region' ,`zone`] }", ["region", "zone"]],
    ["a trailing comma", 'outputs={["region",]}', ["region"]],
    ["an empty array", "outputs={[]}", []],
  ])("reads %s", (_name, props, expected) => {
    expect(extractStringArrayProp(props, "outputs")).toEqual(expected)
  })

  it.each([
    ["an absent prop", 'id="p"'],
    ["a non-string item", "outputs={[1, 2]}"],
    ["items without a separator", 'outputs={["a" "b"]}'],
    ["a string prop", 'outputs="region"'],
  ])("returns undefined for %s", (_name, props) => {
    expect(extractStringArrayProp(props, "outputs")).toBeUndefined()
  })

  it("matches the whole prop name", () => {
    expect(extractStringArrayProp('myoutputs={["x"]}', "outputs")).toBeUndefined()
  })
})

describe("computeExecutableId", () => {
  it("returns deterministic value", () => {
    const id1 = computeExecutableId("cmd1", "echo hi")
    const id2 = computeExecutableId("cmd1", "echo hi")
    expect(id1).toBe(id2)
  })

  it("returns different values for different inputs", () => {
    const id1 = computeExecutableId("cmd1", "echo hi")
    const id2 = computeExecutableId("cmd2", "echo hi")
    expect(id1).not.toBe(id2)
  })

  it("returns 16-character hex string", () => {
    const id = computeExecutableId("cmd1", "content")
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("computeComponentId", () => {
  it("returns deterministic value prefixed with component type", () => {
    const id = computeComponentId("Command", 'command="echo hi"')
    expect(id).toMatch(/^Command_[0-9a-f]{8}$/)
  })

  it("returns different IDs for different props", () => {
    const id1 = computeComponentId("Command", 'command="a"')
    const id2 = computeComponentId("Command", 'command="b"')
    expect(id1).not.toBe(id2)
  })
})

describe("getComponentRegex", () => {
  it("matches self-closing component", () => {
    const re = getComponentRegex("Command")
    const match = re.exec('<Command id="x" command="echo" />')
    expect(match).not.toBeNull()
  })

  it("matches container component", () => {
    const re = getComponentRegex("Command")
    const match = re.exec('<Command id="x">script content</Command>')
    expect(match).not.toBeNull()
    expect(match![2]).toBe("script content")
  })

  it("does not match components without props", () => {
    const re = getComponentRegex("Command")
    const match = re.exec("<Command/>")
    expect(match).toBeNull()
  })
})

describe("parseComponents", () => {
  it("extracts components from MDX", () => {
    const mdx = '<Command id="cmd1" command="echo hi" />'
    const result = parseComponents(mdx, "Command")
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("cmd1")
    expect(result[0]!.hasExplicitId).toBe(true)
  })

  it("generates ID when none is provided", () => {
    const mdx = '<Command command="echo hi" />'
    const result = parseComponents(mdx, "Command")
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toMatch(/^Command_/)
    expect(result[0]!.hasExplicitId).toBe(false)
  })

  it("skips components inside fenced code blocks", () => {
    const mdx = `
Some text
\`\`\`
<Command id="example" command="echo" />
\`\`\`
<Command id="real" command="echo real" />
`
    const result = parseComponents(mdx, "Command")
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("real")
  })

  it("deduplicates by ID", () => {
    const mdx = `
<Command id="cmd1" command="echo a" />
<Command id="cmd1" command="echo b" />
`
    const result = parseComponents(mdx, "Command")
    expect(result).toHaveLength(1)
  })

  it("parses container components with content", () => {
    const mdx = '<Check id="chk1">echo ok</Check>'
    const result = parseComponents(mdx, "Check")
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toContain("echo ok")
  })

  it("uses the id prop, not an id-like flag inside the command", () => {
    const mdx =
      '<Command title="Assume role" command={`aws sts assume-role --role-session-name="runbooks" --external-id="{{ .inputs.ExternalId }}"`} id="assume-role" />'
    const result = parseComponents(mdx, "Command")
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("assume-role")
    expect(result[0]!.hasExplicitId).toBe(true)
  })

  it("returns the real block when a nested example reuses its id", () => {
    const mdx = [
      "````mdx",
      "```mdx",
      '<Command id="deploy" command="echo example" />',
      "```",
      "````",
      "",
      '<Command id="deploy" command="tofu apply" />',
    ].join("\n")
    const result = parseComponents(mdx, "Command")
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("deploy")
    expect(result[0]!.props).toContain("tofu apply")
  })

  it("records each component's offset in the source", () => {
    const mdx = 'Intro\n\n<Check id="a" command="echo a" />\n<Check id="b" command="echo b" />\n'
    const result = parseComponents(mdx, "Check")
    expect(result.map((c) => c.index)).toEqual([
      mdx.indexOf('<Check id="a"'),
      mdx.indexOf('<Check id="b"'),
    ])
  })
})

describe("ExecutableRegistry", () => {
  it("registers inline command with command prop", async () => {
    const mdx = '<Command id="cmd1" command="echo hello" />'
    const layer = makeTestFileSystem({ "/runbook.mdx": mdx })

    const registry = await Effect.runPromise(
      ExecutableRegistry.create("/runbook.mdx").pipe(Effect.provide(layer)),
    )

    const all = registry.getAllExecutables()
    const entries = Object.values(all)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.componentId).toBe("cmd1")
    expect(entries[0]!.componentType).toBe("command")
    expect(entries[0]!.type).toBe("inline")
  })

  it("registers file-based command with path prop", async () => {
    const mdx = '<Command id="cmd1" path="scripts/test.sh" />'
    const layer = makeTestFileSystem({
      "/runbook.mdx": mdx,
      "/scripts/test.sh": "echo test",
    })

    const registry = await Effect.runPromise(
      ExecutableRegistry.create("/runbook.mdx").pipe(Effect.provide(layer)),
    )

    const entries = Object.values(registry.getAllExecutables())
    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe("file")
    expect(entries[0]!.path).toBe("scripts/test.sh")
  })

  it("produces warning for missing script file", async () => {
    const mdx = '<Command id="cmd1" path="missing.sh" />'
    const layer = makeTestFileSystem({ "/runbook.mdx": mdx })

    const registry = await Effect.runPromise(
      ExecutableRegistry.create("/runbook.mdx").pipe(Effect.provide(layer)),
    )

    expect(registry.getWarnings()).toHaveLength(1)
    expect(registry.getWarnings()[0]).toContain("not found")
  })

  it("getExecutable returns entry by ID", async () => {
    const mdx = '<Command id="cmd1" command="echo hello" />'
    const layer = makeTestFileSystem({ "/runbook.mdx": mdx })

    const registry = await Effect.runPromise(
      ExecutableRegistry.create("/runbook.mdx").pipe(Effect.provide(layer)),
    )

    const entries = Object.values(registry.getAllExecutables())
    const entry = await Effect.runPromise(registry.getExecutable(entries[0]!.id))
    expect(entry.componentId).toBe("cmd1")
  })

  it("getExecutable fails with ExecutableNotFoundError for unknown ID", async () => {
    const mdx = '<Command id="cmd1" command="echo" />'
    const layer = makeTestFileSystem({ "/runbook.mdx": mdx })

    const registry = await Effect.runPromise(
      ExecutableRegistry.create("/runbook.mdx").pipe(Effect.provide(layer)),
    )

    const exit = await Effect.runPromiseExit(registry.getExecutable("nonexistent"))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("getAllExecutables strips content field", async () => {
    const mdx = '<Command id="cmd1" command="echo secret" />'
    const layer = makeTestFileSystem({ "/runbook.mdx": mdx })

    const registry = await Effect.runPromise(
      ExecutableRegistry.create("/runbook.mdx").pipe(Effect.provide(layer)),
    )

    const all = registry.getAllExecutables()
    for (const entry of Object.values(all)) {
      expect("content" in entry).toBe(false)
    }
  })

  it("unescapes HTML entities in inline commands", async () => {
    const mdx = '<Command id="cmd1" command="echo &amp; hello" />'
    const layer = makeTestFileSystem({ "/runbook.mdx": mdx })

    const registry = await Effect.runPromise(
      ExecutableRegistry.create("/runbook.mdx").pipe(Effect.provide(layer)),
    )

    const entries = Object.keys(registry.getAllExecutables())
    const entry = await Effect.runPromise(registry.getExecutable(entries[0]!))
    expect(entry.content).toContain("& hello")
  })

  it("registers blocks that share an id-like flag under their own ids", async () => {
    const flag = '--external-id="{{ .inputs.ExternalId }}"'
    const mdx = [
      `<Command command={\`aws sts assume-role ${flag}\`} id="assume-role" />`,
      `<Command command={\`aws sts assume-role --duration-seconds=900 ${flag}\`} id="assume-role-short" />`,
    ].join("\n")
    const layer = makeTestFileSystem({ "/runbook.mdx": mdx })

    const registry = await Effect.runPromise(
      ExecutableRegistry.create("/runbook.mdx").pipe(Effect.provide(layer)),
    )

    const componentIds = Object.values(registry.getAllExecutables()).map((e) => e.componentId)
    expect(componentIds.sort()).toEqual(["assume-role", "assume-role-short"])
  })

  it("extracts template variables from script content", async () => {
    const mdx = '<Command id="cmd1" command="echo {{.Name}} {{.Region}}" />'
    const layer = makeTestFileSystem({ "/runbook.mdx": mdx })

    const registry = await Effect.runPromise(
      ExecutableRegistry.create("/runbook.mdx").pipe(Effect.provide(layer)),
    )

    const entries = Object.keys(registry.getAllExecutables())
    const entry = await Effect.runPromise(registry.getExecutable(entries[0]!))
    expect(entry.templateVars).toContain("Name")
    expect(entry.templateVars).toContain("Region")
  })

  describe("a script file that changes after it was registered", () => {
    const SCRIPT = "/rb/scripts/deploy.sh"

    /**
     * A registry built from a runbook with a file-based block and an inline
     * one. `files` is the disk: writing to it changes what the registry reads
     * next. `run` runs a registry effect against that disk.
     */
    async function loadRunbook() {
      const files: Record<string, string> = {
        "/rb/runbook.mdx":
          '<Command id="deploy" path="scripts/deploy.sh" />\n<Check id="greet" command="echo hi" />',
        [SCRIPT]: "echo v1 {{ .Region }}",
      }
      const layer = makeTestFileSystem(files)
      const registry = await Effect.runPromise(
        ExecutableRegistry.create("/rb/runbook.mdx").pipe(Effect.provide(layer)),
      )
      const run = <A, E>(effect: Effect.Effect<A, E, FileSystem>) =>
        Effect.runPromiseExit(effect.pipe(Effect.provide(layer)))
      const deployEntry = () => {
        const id = Object.values(registry.getAllExecutables()).find(
          (e) => e.componentId === "deploy",
        )!.id
        return registry.getExecutableSync(id)!
      }
      return { files, registry, run, deployEntry }
    }

    it("lists the script files its file entries were read from", async () => {
      const { registry } = await loadRunbook()
      expect(registry.getScriptPaths()).toEqual([SCRIPT])
    })

    it("names the components that run a given script file, and none for other files", async () => {
      const { registry } = await loadRunbook()
      expect(registry.getComponentIdsForScripts([SCRIPT])).toEqual(["deploy"])
      expect(
        registry.getComponentIdsForScripts(["/rb/scripts/other.sh", "/rb/runbook.mdx"]),
      ).toEqual([])
    })

    it("reports no change while the file matches the registered copy", async () => {
      const { registry, run } = await loadRunbook()
      expect(await run(registry.getScriptFileChange("deploy"))).toEqual(Exit.succeed(null))
    })

    it("reports the registered copy and the file on disk once they differ, and keeps the registered copy", async () => {
      const { files, registry, run, deployEntry } = await loadRunbook()
      files[SCRIPT] = "echo v2"

      expect(await run(registry.getScriptFileChange("deploy"))).toEqual(
        Exit.succeed({
          registeredContent: "echo v1 {{ .Region }}",
          diskContent: "echo v2",
          diskContentHash: computeContentHash("echo v2"),
        }),
      )
      expect(deployEntry().content).toBe("echo v1 {{ .Region }}")
    })

    it("reports no change for a deleted script file and for a block without one", async () => {
      const { files, registry, run } = await loadRunbook()
      delete files[SCRIPT]

      expect(await run(registry.getScriptFileChange("deploy"))).toEqual(Exit.succeed(null))
      expect(await run(registry.getScriptFileChange("greet"))).toEqual(Exit.succeed(null))
    })

    it("reloadFileEntry registers the reviewed version under a new entry ID", async () => {
      const { files, registry, run, deployEntry } = await loadRunbook()
      const before = deployEntry()
      files[SCRIPT] = "echo v2 {{ .Zone }}"

      const exit = await run(registry.reloadFileEntry("deploy", computeContentHash(files[SCRIPT])))

      expect(Exit.isSuccess(exit)).toBe(true)
      const after = deployEntry()
      expect(after).toEqual({
        ...before,
        id: computeExecutableId("deploy", files[SCRIPT]),
        content: files[SCRIPT],
        contentHash: computeContentHash(files[SCRIPT]),
        templateVars: ["Zone"],
      })
      // The replaced version can't be run by its old ID.
      expect(registry.getExecutableSync(before.id)).toBeUndefined()
      expect(Object.keys(registry.getAllExecutables())).toHaveLength(2)
      expect(registry.getScriptPaths()).toEqual([SCRIPT])
      expect(await run(registry.getScriptFileChange("deploy"))).toEqual(Exit.succeed(null))
    })

    it("reloadFileEntry fails, and keeps the registered copy, when the file is not the reviewed version", async () => {
      const { files, registry, run, deployEntry } = await loadRunbook()
      const before = deployEntry()
      const reviewedHash = computeContentHash("echo v2")
      // The file changed again between the review and the reload.
      files[SCRIPT] = "echo v3"

      const exit = await run(registry.reloadFileEntry("deploy", reviewedHash))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("ScriptReloadConflictError")
      expect(deployEntry()).toEqual(before)
    })

    it("reloadFileEntry fails for a block without a script file", async () => {
      const { registry, run } = await loadRunbook()

      const exit = await run(registry.reloadFileEntry("greet", computeContentHash("echo hi")))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("ExecutableNotFoundError")
    })
  })
})
