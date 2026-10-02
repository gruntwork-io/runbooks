/**
 * Long paths and URLs must wrap inside their block instead of pushing it past
 * its border.
 *
 * A path or URL is one long word. Inside a flex item that keeps the default
 * `min-width: auto`, that word sets the item's min-content width, so the item
 * (and everything it holds) overflows the block and the runbook pane grows a
 * horizontal scrollbar. This launches the real app at a ~900px window on a
 * runbook generated at test time — Admonitions, Command/Check descriptions,
 * every auth block's description, a GitClone local-checkout completion for a
 * repo under a long temp path, and a "Can't use this directory" error panel —
 * and measures the rendered layout. A second test checks that the full-width
 * command box and separator of untitled Command/Check blocks stay clear of the
 * ID label pinned to the block's top-right corner.
 *
 * git runs with a sandboxed HOME and GIT_CONFIG_GLOBAL/SYSTEM=/dev/null, both
 * for the fixture repo (every spawn gets that env explicitly) and for the app.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts long-paths.spec.ts
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { resizeMainWindow } from "./main-process.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

// Letters only: hyphens, dots and spaces are break opportunities, and the point
// is a word the browser cannot break on its own.
const SEGMENT = "averyveryverylongdirectorynamewithnobreakopportunities"
const LONG_URL = `https://example.com/${SEGMENT}/${SEGMENT}/${SEGMENT}`
const REMOTE_URL = `https://github.com/averyveryverylongorganizationname/${SEGMENT}.git`
// Identifiers that must stay whole inside a markdown table cell.
const TABLE_IDENTIFIERS = [
  "first_really_long_terraform_variable_name_here",
  "second_really_long_terraform_variable_name_here",
  "third_really_long_terraform_variable_name_here",
]

const WINDOW_WIDTH = 900

let app: ElectronApplication
let page: Page
let workDir: string
let repoDir: string

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  execFileSync("git", args, { cwd, env, stdio: "pipe" })
}

function runbookMdx(): string {
  const longPath = path.join(repoDir, "plan.tfplan")
  const tableRows = TABLE_IDENTIFIERS.map((id) => `\`${id}\``).join(" | ")
  return `# Long paths

<Admonition type="info" title="Admonition with a long path">
The plan is written to \`${longPath}\`. Read more at ${LONG_URL}.
</Admonition>

<Admonition type="note" title="Admonition with a table">

| First | Second | Third |
|---|---|---|
| ${tableRows} |

</Admonition>

<Command id="cmd-described" title="Write the plan" description="Writes \`${longPath}\` (docs: ${LONG_URL})" command="echo described" />

<Command id="cmd-untitled" command="echo untitled" />

<Check id="check-untitled" command="exit 0" />

<Check id="check-path-untitled" path="checks/ok.sh" />

<AwsAuth id="aws-long" title="AWS" description="Profiles come from \`${longPath}\`. See ${LONG_URL}." />

<GoogleAuth id="gcp-long" title="Google Cloud" description="Keys come from \`${longPath}\`. See ${LONG_URL}." />

<GitAuth id="git-long" title="Git" description="Tokens come from \`${longPath}\`. See ${LONG_URL}." />

<GitHubAuth id="github-long" title="GitHub" description="Tokens come from \`${longPath}\`. See ${LONG_URL}." />

<GitLabAuth id="gitlab-long" title="GitLab" description="Tokens come from \`${longPath}\`. See ${LONG_URL}." />

<GitClone id="local-long" title="Use the long checkout" source="local" prefilledRepoDir="${repoDir}" />

<GitClone id="missing-long" title="Use a missing checkout" source="local" prefilledRepoDir="${path.join(repoDir, SEGMENT)}" />
`
}

test.beforeAll(async () => {
  // realpath: macOS tmpdir is a /var symlink, and git reports /private/var.
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-long-paths-e2e-")))
  const home = path.join(workDir, "home")
  const userDataDir = path.join(workDir, "user-data")
  const runbookDir = path.join(workDir, "runbook")
  repoDir = path.join(workDir, SEGMENT, SEGMENT, SEGMENT)
  for (const dir of [home, userDataDir, runbookDir, repoDir]) fs.mkdirSync(dir, { recursive: true })

  // Ambient credentials would change what the auth blocks render; the
  // sandboxed HOME keeps aws/gcloud/gh/glab config and ~/.gitconfig out too.
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(AWS_|GOOGLE_|CLOUDSDK_|GITHUB_|GITLAB_|GH_|GLAB_|GL_)/.test(key)) delete env[key]
  }
  Object.assign(env, {
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Runbooks E2E",
    GIT_AUTHOR_EMAIL: "e2e@example.com",
    GIT_COMMITTER_NAME: "Runbooks E2E",
    GIT_COMMITTER_EMAIL: "e2e@example.com",
    ELECTRON_NO_UPDATER: "1",
    RUNBOOKS_TELEMETRY_DISABLE: "1",
    // Skip populateShellEnv so the sandboxed HOME and git env survive.
    TERM_PROGRAM: "runbooks-e2e",
  })

  git(["init", "-q", "-b", "main"], repoDir, env)
  fs.writeFileSync(path.join(repoDir, "README.md"), "long paths\n")
  git(["add", "README.md"], repoDir, env)
  git(["commit", "-q", "-m", "init"], repoDir, env)
  git(["remote", "add", "origin", REMOTE_URL], repoDir, env)

  fs.writeFileSync(path.join(runbookDir, "runbook.mdx"), runbookMdx())
  fs.mkdirSync(path.join(runbookDir, "checks"))
  fs.writeFileSync(path.join(runbookDir, "checks", "ok.sh"), "#!/bin/bash\nexit 0\n")

  app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, runbookDir],
    env: env as Record<string, string>,
  })
  page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  await resizeMainWindow(app, WINDOW_WIDTH, 900)
  await expect.poll(() => page.evaluate(() => window.outerWidth)).toBe(WINDOW_WIDTH)
  await page.waitForSelector("h1", { timeout: 60_000 })

  const trustButton = page.getByRole("button", { name: "I trust this Runbook" })
  if (await trustButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await trustButton.click()
    await expect(trustButton).not.toBeVisible({ timeout: 5_000 })
  }
})

test.afterAll(async () => {
  if (app) await app.close()
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
})

interface Overflow {
  block: string
  node: string
  overBy: number
}

/**
 * Every in-flow element and text run inside a `.runbook-block` whose right edge
 * passes the block's own right edge. Content under a scroll/clip container
 * inside the block (a scrolling table, a `pre`) is contained by that container,
 * which is itself measured; absolutely positioned boxes are out of flow.
 */
function findOverflows(): Overflow[] {
  const describe = (el: Element): string => {
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60)
    return `<${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}"> ${text}`
  }
  const inFlow = (el: Element, block: Element): boolean => {
    for (let n: Element | null = el; n && n !== block; n = n.parentElement) {
      const style = getComputedStyle(n)
      if (style.position === "absolute" || style.position === "fixed") return false
      if (n !== el && style.overflowX !== "visible") return false
    }
    return true
  }
  const out: Overflow[] = []
  for (const block of Array.from(document.querySelectorAll(".runbook-block"))) {
    const limit = block.getBoundingClientRect().right + 1
    const blockName = block.getAttribute("data-testid") ?? describe(block)
    for (const el of Array.from(block.querySelectorAll("*"))) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      if (rect.right > limit && inFlow(el, block)) {
        out.push({ block: blockName, node: describe(el), overBy: Math.round(rect.right - limit) })
      }
    }
    // Text can overflow the box it sits in without that box growing.
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!parent || !node.textContent?.trim() || !inFlow(parent, block)) continue
      if (parent !== block && getComputedStyle(parent).overflowX !== "visible") continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = range.getBoundingClientRect()
      if (rect.width > 0 && rect.right > limit) {
        out.push({
          block: blockName,
          node: `text in ${describe(parent)}`,
          overBy: Math.round(rect.right - limit),
        })
      }
    }
  }
  return out
}

test("long paths and URLs stay inside their blocks at a narrow window", async () => {
  // GitClone local checkout: preview the long path, then complete the block.
  const local = page.getByTestId("local-long")
  await local.scrollIntoViewIfNeeded()
  await expect(local.getByText("Git repository found")).toBeVisible({ timeout: 20_000 })
  await local.getByRole("button", { name: "Use This Repo" }).click()
  // Below the lg breakpoint, registering a worktree flips the single-pane
  // layout to the Code view; flip it back once that has happened.
  const content = page.getByTestId("runbook-content")
  await expect(content).toBeHidden({ timeout: 20_000 })
  await page.getByRole("button", { name: "Markdown" }).click()
  await expect(content).toBeVisible()
  await expect(local.getByText("Using local checkout")).toBeVisible({ timeout: 20_000 })
  await expect(local.getByText(REMOTE_URL)).toBeVisible()

  // Error panel: a missing directory under the same long path.
  const missing = page.getByTestId("missing-long")
  await expect(missing.getByText("Can't use this directory")).toBeVisible({ timeout: 20_000 })
  await expect(missing.getByText(/Directory not found:/)).toBeVisible()

  // Every auth block has rendered its description.
  for (const id of ["aws-long", "gcp-long", "git-long", "github-long", "gitlab-long"]) {
    await expect(page.getByTestId(id).getByText(LONG_URL).first()).toBeVisible({ timeout: 20_000 })
  }

  expect(await page.evaluate(findOverflows)).toEqual([])

  // Identifiers in a markdown table stay whole on one line: a table too wide
  // for the block scrolls (github-markdown.css gives it overflow: auto)
  // rather than splitting code mid-word.
  for (const id of TABLE_IDENTIFIERS) {
    const code = page.locator(".runbook-block td code", { hasText: id })
    expect(await code.evaluate((el) => el.getClientRects().length), id).toBe(1)
  }

  const widths = await content.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }))
  expect(widths.scroll).toBe(widths.client)
})

/**
 * Where a Command/Check row (the inline command box, or the separator under
 * it) sits relative to the ID label pinned to the block's top-right corner,
 * and how much of its column's width it leaves free on the right.
 */
async function rowLayout(blockId: string, row: Locator) {
  await page.getByTestId(blockId).scrollIntoViewIfNeeded()
  const label = await page.getByTestId(blockId).getByText("ID", { exact: true }).boundingBox()
  const box = await row.boundingBox()
  if (!label || !box) throw new Error(`${blockId}: ID label or row not rendered`)
  const underLabel =
    box.x < label.x + label.width &&
    label.x < box.x + box.width &&
    box.y < label.y + label.height &&
    label.y < box.y + box.height
  const rightGap = await row.evaluate(
    (el) => el.parentElement!.getBoundingClientRect().right - el.getBoundingClientRect().right,
  )
  return { underLabel, rightGap }
}

const commandBox = (blockId: string, command: string) =>
  rowLayout(blockId, page.getByTestId(blockId).getByText(command, { exact: true }))

test("the command box and separator never sit under the block ID label", async () => {
  // Untitled pending Check: it has no placeholder line, so the command box is
  // the block's first row.
  const check = await commandBox("check-untitled", "exit 0")
  expect.soft(check.underLabel, "untitled Check: command box under the ID label").toBe(false)
  expect.soft(check.rightGap, "untitled Check: no room left for the ID label").toBeGreaterThan(0)

  // Untitled path-based Check: there is no command box, so the separator is
  // the first row (and the block's first border-b element).
  const separator = await rowLayout(
    "check-path-untitled",
    page.getByTestId("check-path-untitled").locator(".border-b.border-border").first(),
  )
  expect.soft(separator.underLabel, "untitled path Check: separator under the ID label").toBe(false)

  // Untitled Command: a status line ("Run a command", then "Success") sits
  // above the box, which keeps one width across those states.
  const pending = await commandBox("cmd-untitled", "echo untitled")
  expect
    .soft(pending.underLabel, "pending untitled Command: command box under the ID label")
    .toBe(false)
  const block = page.getByTestId("cmd-untitled")
  await block.getByRole("button", { name: "Run" }).click()
  await expect(block.getByTestId("icon-success")).toBeVisible({ timeout: 30_000 })
  const ran = await commandBox("cmd-untitled", "echo untitled")
  expect
    .soft(ran.underLabel, "untitled Command after a run: command box under the ID label")
    .toBe(false)
  expect
    .soft(ran.rightGap, "untitled Command: box width changes once it has run")
    .toBe(pending.rightGap)

  // Titled: the title row sits beside the label, and the box spans the column.
  const titled = await commandBox("cmd-described", "echo described")
  expect.soft(titled.underLabel, "titled Command: command box under the ID label").toBe(false)
  expect.soft(titled.rightGap, "titled Command: command box does not span its column").toBe(0)
})
