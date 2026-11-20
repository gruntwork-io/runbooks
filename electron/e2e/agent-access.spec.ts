/**
 * E2E test for AI agent access (electron/main/agent/): the MCP server the
 * app serves on 127.0.0.1 drives the runbook open in the window.
 *
 * Through the real app: the Header menu turns access on, an MCP client with
 * the token from the headers file fills in a form, asks to run a block (the
 * user approves in the window), waits for it and reads its logs and outputs,
 * while the window shows the run and that an agent is connected.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts agent-access.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { MOCK_KEYCHAIN } from "./launch.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

const RUNBOOK = `# Agent demo

<Inputs id="config">
\`\`\`yaml
variables:
  - name: Name
    type: string
    validations:
      - required
\`\`\`
</Inputs>

<Command
  id="greet"
  title="Greet"
  inputsId="config"
  env={{ NAME: "{{ .inputs.Name }}" }}
  command='echo "hello $NAME"; echo "greeting=hi-$NAME" >> "$RUNBOOK_OUTPUT"'
/>
`

let workDir: string
let app: ElectronApplication

test.setTimeout(120_000)

test.beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-agent-e2e-"))
  const runbookDir = path.join(workDir, "runbook")
  fs.mkdirSync(runbookDir)
  fs.writeFileSync(path.join(runbookDir, "runbook.mdx"), RUNBOOK)
  const userDataDir = path.join(workDir, "user-data")
  fs.mkdirSync(userDataDir)
  app = await electron.launch({
    args: [MAIN_ENTRY, MOCK_KEYCHAIN, `--user-data-dir=${userDataDir}`, runbookDir],
    env: {
      ...process.env,
      ELECTRON_NO_UPDATER: "1",
      RUNBOOKS_TELEMETRY_DISABLE: "1",
      TERM_PROGRAM: "e2e",
      RUNBOOKS_AGENT_PORT: "0",
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  fs.rmSync(workDir, { recursive: true, force: true })
})

test("an MCP client fills in a form and runs a block in the open session", async () => {
  const page = await app.firstWindow()
  await page.waitForSelector("h1", { timeout: 60_000 })
  const trust = page.getByRole("button", { name: "I trust this Runbook" })
  if (await trust.isVisible({ timeout: 3_000 }).catch(() => false)) await trust.click()

  // Off by default: turn it on from the Header menu
  await page.getByRole("button", { name: "Menu" }).click()
  await page.getByRole("menuitem", { name: "AI Agent Access…" }).click()
  const dialog = page.getByRole("dialog", { name: "AI Agent Access" })
  const enabled = dialog.getByTestId("agent-access-enabled")
  await expect(enabled).not.toBeChecked()
  // Checked once main has started the server
  await enabled.click()
  await expect(enabled).toBeChecked()
  // Everything stays inside the dialog: the long command and configuration
  // wrap in their boxes, and nothing reaches under the close button
  const overflow = await dialog.evaluate((panel) => {
    const box = panel.getBoundingClientRect()
    const close = panel.querySelector("[data-slot='dialog-close']")?.getBoundingClientRect()
    const outside = [...panel.querySelectorAll("p, code, pre, label")]
      .filter((el) => el.getBoundingClientRect().right > box.right + 1)
      .map((el) => el.tagName)
    const underClose = close
      ? [...panel.querySelectorAll("h2, p")].filter((el) => {
          const r = el.getBoundingClientRect()
          return r.right > close.left && r.top < close.bottom && r.bottom > close.top
        }).length
      : 0
    return { outside, underClose, scrolls: panel.scrollWidth > panel.clientWidth }
  })
  expect(overflow).toEqual({ outside: [], underClose: 0, scrolls: false })
  const command = await dialog.locator("code").first().textContent()
  const url = /(http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(command ?? "")![1]!
  await page.keyboard.press("Escape")

  // The token is in the headers file in userData
  const headersFile = path.join(workDir, "user-data", "agent-mcp-headers.json")
  const headers = JSON.parse(fs.readFileSync(headersFile, "utf8")) as Record<string, string>
  expect((await fetch(url, { method: "POST" })).status).toBe(401)

  const client = new Client({ name: "e2e", version: "0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
  )
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const text = (result.content as Array<{ text: string }>)[0]!.text
    expect(result.isError, text).toBeFalsy()
    return JSON.parse(text)
  }

  try {
    const session = await call("get_session")
    expect(session.open).toBe(true)
    expect(session.blocks.map((b: { id: string }) => b.id)).toEqual(["config", "greet"])
    const greet = session.blocks.find((b: { id: string }) => b.id === "greet")
    expect(greet.blockedBy.join()).toContain("Name")

    // Stopped at the form the Command reads, until the agent reviews it
    const early = await call("run_block", { block_id: "greet" })
    expect(early.started).toBe(false)
    expect(early.needsReview).toMatchObject({ form: "config", unreviewed: ["Name"] })

    const filled = await call("set_inputs", { block_id: "config", values: { Name: "e2e" } })
    expect(filled.errors).toEqual({})
    // Typed into the window's form
    await expect(page.getByTestId("config").getByRole("textbox").first()).toHaveValue("e2e")

    // Submit the form, as its Submit button does: its values then reach the Command
    expect(await call("run_block", { block_id: "config" })).toEqual({ started: true })
    await expect
      .poll(async () => (await call("get_block", { block_id: "greet" })).blockedBy, {
        timeout: 10_000,
      })
      .toEqual([])

    // The user approves the run in the window
    const run = call("run_block", { block_id: "greet" })
    await page.getByTestId("agent-confirm-run").click()
    expect(await run).toEqual({ started: true })

    const done = await call("wait_for_block", { block_id: "greet", timeout_seconds: 30 })
    expect(done.status).toBe("success")
    expect(done.timed_out).toBe(false)
    expect(done.logs.join("\n")).toContain("hello e2e")
    expect(await call("get_outputs")).toMatchObject({ greet: { greeting: "hi-e2e" } })

    // The window shows the run, and that an agent is connected
    await expect(page.getByTestId("greet").getByText("hello e2e").first()).toBeVisible()
    await expect(page.getByTestId("agent-indicator")).toBeVisible()
  } finally {
    await client.close()
  }
})
