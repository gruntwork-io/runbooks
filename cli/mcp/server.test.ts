/**
 * Tests for the MCP server: real runbooks run through the MCP tools with a
 * real MCP client, in memory, plus one over stdio through the CLI entry point.
 */
import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { createMcpServer } from "./server.ts"
import { unsupportedTemplateActions } from "./session.ts"

setDefaultTimeout(30_000)

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..")
const MY_FIRST_RUNBOOK = path.join(REPO_ROOT, "testdata", "sample-runbooks", "my-first-runbook")
const CLI_ENTRY = path.join(REPO_ROOT, "cli", "index.ts")

// No Azure credentials, whatever the machine running the tests has
const NO_AZURE: Record<string, string> = {
  AZURE_CONFIG_DIR: "",
  ARM_CLIENT_ID: "",
  AZURE_CLIENT_ID: "",
}

const DEPENDENCIES_MDX = `# Dependencies

<Inputs id="config">
\`\`\`yaml
variables:
  - name: Name
    type: string
    validations:
      - required
\`\`\`
</Inputs>

<Command id="make-id" inputsId="config" command='echo "id=abc-{{ .inputs.Name }}" >> "$RUNBOOK_OUTPUT"' />

<Command id="use-id" env={{ ID: "{{ .outputs.make_id.id }}" }} command='echo "using $ID"' />

<Command id="log-in" command="export DEMO_TOKEN=secret" />

<Check id="use-token" dependsOn="log-in" command='test "$DEMO_TOKEN" = secret' />

<AzureAuth id="azure" />

<Command id="list-groups" azureAuthId="azure" command="echo groups" />

<GitHubPullRequest id="open-pr" />
`

let tmp: string
let client: Client

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await createMcpServer().connect(serverTransport)
  const c = new Client({ name: "test", version: "0.0.0" })
  await c.connect(clientTransport)
  return c
}

/** Call a tool and parse its JSON result; fails the test on a tool error. */
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text
  if (result.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text)
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-mcp-test-"))
  client = await connect()
})

afterEach(async () => {
  await client.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("tools", () => {
  it("lists the tools, marking the ones that run scripts as destructive", async () => {
    const { tools } = await client.listTools()
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(Object.keys(byName).sort()).toEqual([
      "close_runbook",
      "get_block",
      "get_outputs",
      "get_runbook",
      "open_runbook",
      "run_all",
      "run_block",
      "set_inputs",
      "skip_block",
    ])
    for (const name of ["run_block", "run_all"]) {
      expect(byName[name]!.annotations?.destructiveHint).toBe(true)
      expect(byName[name]!.description).toContain("real cloud resources")
    }
    expect(byName["get_block"]!.annotations?.readOnlyHint).toBe(true)
  })
})

describe("my-first-runbook", () => {
  it("opens without running anything, then runs the template and commands", async () => {
    const opened = await call("open_runbook", { path: MY_FIRST_RUNBOOK, working_dir: tmp })
    const sid = opened.session_id
    expect(opened.blocks.map((b: any) => b.id)).toEqual([
      "check-git",
      "check-git-version",
      "git-version-inputs",
      "project",
      "run-setup",
      "final-message",
    ])
    expect(opened.blocks.every((b: any) => b.status === "not_run")).toBe(true)
    expect(opened.limitations.join("\n")).toContain("can change real cloud resources")
    expect(fs.existsSync(path.join(tmp, "generated"))).toBe(false)

    // The Template's variables, with their schema
    const project = opened.inputs.find((i: any) => i.block === "project")
    const keys = project.variables.map((v: any) => v.key)
    expect(keys).toContain("project.ProjectName")
    expect(keys).toContain("project.Language")

    const set = await call("set_inputs", {
      session_id: sid,
      values: {
        "project.ProjectName": "mcp-project",
        "project.Author": "Ada",
        "project.Language": "Go",
      },
    })
    expect(set.input_errors).toEqual([])

    const bad = await call("set_inputs", { session_id: sid, values: { "project.Nope": "x" } })
    expect(bad.input_errors.join("\n")).toContain("project.Nope")

    await call("skip_block", { session_id: sid, block_id: "check-git" })
    await call("skip_block", { session_id: sid, block_id: "check-git-version" })

    const template = await call("run_block", { session_id: sid, block_id: "project" })
    expect(template.status).toBe("success")
    const readme = fs.readFileSync(path.join(tmp, "generated", "README.md"), "utf-8")
    expect(readme).toContain("mcp-project")
    expect(readme).toContain("Ada")

    const all = await call("run_all", { session_id: sid })
    expect(all.stopped_at).toBeUndefined()
    expect(all.ran.map((r: any) => [r.id, r.status])).toEqual([
      ["git-version-inputs", "valid"],
      ["run-setup", "success"],
      ["final-message", "success"],
    ])

    const final = await call("get_block", { session_id: sid, block_id: "final-message" })
    expect(final.last_run.exit_code).toBe(0)
    expect(final.last_run.logs).toContain("Congratulations")

    const view = await call("get_runbook", { session_id: sid })
    expect(view.blocks.find((b: any) => b.id === "check-git").status).toBe("skipped")

    const closed = await call("close_runbook", { session_id: sid })
    expect(closed.working_dir).toBe(tmp)
    const after = await client.callTool({ name: "get_runbook", arguments: { session_id: sid } })
    expect(after.isError).toBe(true)
  })
})

describe("blocked blocks", () => {
  let sid: string

  beforeEach(async () => {
    const dir = path.join(tmp, "runbook")
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, "runbook.mdx"), DEPENDENCIES_MDX)
    const opened = await call("open_runbook", {
      path: dir,
      working_dir: path.join(tmp, "work"),
      env: NO_AZURE,
    })
    sid = opened.session_id
  })

  it("says why each block is blocked, and runs it once it isn't", async () => {
    const view = await call("get_runbook", { session_id: sid })
    const blockedBy = Object.fromEntries(view.blocks.map((b: any) => [b.id, b.blocked_by ?? []]))
    expect(blockedBy["make-id"].join()).toContain("config.Name")
    expect(blockedBy["use-id"].join()).toContain("outputs.make_id.id")
    expect(blockedBy["use-token"].join()).toContain('"log-in"')
    expect(blockedBy["list-groups"].join()).toContain('"azure"')

    // Blocked: not run, with the reasons
    const early = await call("run_block", { session_id: sid, block_id: "use-id" })
    expect(early.status).toBe("blocked")
    expect(early.last_run.error).toContain("outputs.make_id.id")

    await call("set_inputs", { session_id: sid, values: { "config.Name": "x1" } })
    const made = await call("run_block", { session_id: sid, block_id: "make-id" })
    expect(made.status).toBe("success")
    expect(made.outputs).toEqual({ id: "abc-x1" })

    const used = await call("run_block", { session_id: sid, block_id: "use-id" })
    expect(used.status).toBe("success")
    expect(used.last_run.logs).toContain("using abc-x1")

    await call("run_block", { session_id: sid, block_id: "log-in" })
    const token = await call("run_block", { session_id: sid, block_id: "use-token" })
    expect(token.status).toBe("success")

    expect(await call("get_outputs", { session_id: sid })).toEqual({ "make-id": { id: "abc-x1" } })
  })

  it("skips an auth block without credentials and blocks what depends on it", async () => {
    const auth = await call("run_block", { session_id: sid, block_id: "azure" })
    expect(auth.status).toBe("skipped")
    expect(auth.headless_behavior).toContain("Never runs az login")

    const groups = await call("get_block", { session_id: sid, block_id: "list-groups" })
    expect(groups.blocked_by.join()).toContain("skipped or found no credentials")
  })

  it("never runs a pull request block", async () => {
    const pr = await call("run_block", { session_id: sid, block_id: "open-pr" })
    expect(pr.status).toBe("unsupported")
    expect(pr.last_run.error).toContain("Can't run headless")
  })

  it("stops run_all at the first block that can't run", async () => {
    const all = await call("run_all", { session_id: sid })
    expect(all.stopped_at).toBe("make-id")
    expect(all.ran.at(-1).status).toBe("blocked")
  })

  it("reports a failing script with its exit code and logs", async () => {
    const dir = path.join(tmp, "failing")
    fs.mkdirSync(dir)
    fs.writeFileSync(
      path.join(dir, "runbook.mdx"),
      `# F\n\n<Command id="boom" command="echo going down; exit 3" />\n`,
    )
    const opened = await call("open_runbook", { path: dir, working_dir: dir })
    const boom = await call("run_block", { session_id: opened.session_id, block_id: "boom" })
    expect(boom.status).toBe("fail")
    expect(boom.last_run.exit_code).toBe(3)
    expect(boom.last_run.logs).toContain("going down")
  })

  it("errors on an unknown block or session", async () => {
    const res = await client.callTool({
      name: "run_block",
      arguments: { session_id: sid, block_id: "nope" },
    })
    expect(res.isError).toBe(true)
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('no block "nope"')
  })
})

describe("unsupportedTemplateActions", () => {
  it("flags what the headless renderer leaves as written", () => {
    expect(
      unsupportedTemplateActions(
        "{{ .inputs.A }} {{ if .inputs.B }}x{{ else }}y{{ end }} {{ fromJson .outputs.a.b }}",
      ),
    ).toEqual([])
    expect(
      unsupportedTemplateActions('{{ .inputs.A | upper }} {{- .inputs.B }} {{ eq .x "y" }}'),
    ).toEqual(["{{ .inputs.A | upper }}", "{{- .inputs.B }}", '{{ eq .x "y" }}'])
  })
})

describe("stdio", () => {
  it("serves the tools from the CLI entry point", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, "mcp"],
      stderr: "pipe",
    })
    const stdioClient = new Client({ name: "test", version: "0.0.0" })
    await stdioClient.connect(transport)
    try {
      const result = await stdioClient.callTool({
        name: "open_runbook",
        arguments: { path: MY_FIRST_RUNBOOK, working_dir: tmp },
      })
      expect(result.isError).toBeFalsy()
      const opened = JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
      expect(opened.blocks.length).toBe(6)
    } finally {
      await stdioClient.close()
    }
  })
})
