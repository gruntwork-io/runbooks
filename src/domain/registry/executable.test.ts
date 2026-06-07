import { describe, it, expect } from "bun:test"
import { Effect, Exit } from "effect"
import {
  extractProp,
  computeExecutableId,
  computeComponentId,
  getComponentRegex,
  parseComponents,
  ExecutableRegistry,
} from "./executable.ts"
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
    expect(result[0].id).toBe("cmd1")
    expect(result[0].hasExplicitId).toBe(true)
  })

  it("generates ID when none is provided", () => {
    const mdx = '<Command command="echo hi" />'
    const result = parseComponents(mdx, "Command")
    expect(result).toHaveLength(1)
    expect(result[0].id).toMatch(/^Command_/)
    expect(result[0].hasExplicitId).toBe(false)
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
    expect(result[0].id).toBe("real")
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
    expect(result[0].content).toContain("echo ok")
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
    expect(entries[0].componentId).toBe("cmd1")
    expect(entries[0].componentType).toBe("command")
    expect(entries[0].type).toBe("inline")
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
    expect(entries[0].type).toBe("file")
    expect(entries[0].path).toBe("scripts/test.sh")
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
    const entry = await Effect.runPromise(registry.getExecutable(entries[0].id))
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
    const entry = await Effect.runPromise(registry.getExecutable(entries[0]))
    expect(entry.content).toContain("& hello")
  })

  it("extracts template variables from script content", async () => {
    const mdx = '<Command id="cmd1" command="echo {{.Name}} {{.Region}}" />'
    const layer = makeTestFileSystem({ "/runbook.mdx": mdx })

    const registry = await Effect.runPromise(
      ExecutableRegistry.create("/runbook.mdx").pipe(Effect.provide(layer)),
    )

    const entries = Object.keys(registry.getAllExecutables())
    const entry = await Effect.runPromise(registry.getExecutable(entries[0]))
    expect(entry.templateVars).toContain("Name")
    expect(entry.templateVars).toContain("Region")
  })
})
