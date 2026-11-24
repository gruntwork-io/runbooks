/**
 * E2E tests for the Files panel beside the runbook.
 *
 * Launches the real app on a runbook written at test time: a Template, a
 * TemplateInline and a Command generate files; a GitClone block registers a
 * local checkout, and a Command edits it. The tests pin what the panel shows
 * the user: the generated file tree and how it matches the folder on disk,
 * a changed repository file's diff, the list of changed files, switching
 * between the repository and the generated files, the marks on generated
 * files changed since the user last reviewed them, and the divider between
 * the runbook and the panel.
 *
 * GitClone clones only http(s) and `user@host:path` URLs, so the repository
 * here is a checkout made by the test from a local bare repository, which the
 * block's local-checkout source registers. No network, no credentials: git
 * runs with a sandboxed HOME and GIT_CONFIG_GLOBAL/SYSTEM=/dev/null.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts files-panel.spec.ts
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
import { MOCK_KEYCHAIN } from "./launch.ts"
import { readFromMain, resizeMainWindow, runInMain } from "./main-process.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

// The app's default size, which shows the panel beside the runbook (from
// 1250px wide).
const WINDOW_WIDTH = 1280
const WINDOW_HEIGHT = 900

const TEMPLATE_FILES: Record<string, string> = {
  "boilerplate.yml": `variables:
  - name: Name
    type: string
    description: Service name
    default: alpha
`,
  "README.md": `# {{ .Name }}

This line stays the same.
`,
  "config/app.yaml": `name: {{ .Name }}
port: 8080
`,
  "config/static.txt": `unchanged
`,
}

/** The files the Template generates with its default input, by path. */
const GENERATED_DEFAULT: Record<string, string> = {
  "README.md": "# alpha\n\nThis line stays the same.\n",
  "config/app.yaml": "name: alpha\nport: 8080\n",
  "config/static.txt": "unchanged\n",
}

const MAIN_TF = `terraform {
  required_version = ">= 1.6"
}

provider "aws" {
  region = "us-east-1"
}
`

const CAPTURE_SCRIPT = `#!/bin/bash
set -euo pipefail
mkdir -p "$GENERATED_FILES/logs"
echo captured > "$GENERATED_FILES/logs/run.log"
`

// Modifies one tracked file, adds one and deletes one.
const EDIT_REPO_SCRIPT = `#!/bin/bash
set -euo pipefail
cat > "$REPO_FILES/main.tf" <<'EOF'
${MAIN_TF.replace("us-east-1", "eu-west-1")}EOF
echo "new file" > "$REPO_FILES/added.txt"
rm "$REPO_FILES/old.txt"
`

function runbookMdx(checkoutDir: string): string {
  return `# Files panel

<Template id="app" path="templates/app" />

<Inputs id="note">
\`\`\`yaml
variables:
  - name: Note
    type: string
    description: Text for the inline file
\`\`\`
</Inputs>

<TemplateInline id="inline" inputsId="note" outputPath="notes/inline.txt" generateFile={true}>
\`\`\`txt
{{ .inputs.Note }}
\`\`\`
</TemplateInline>

<Command id="capture" title="Capture a file" path="capture.sh" successMessage="Captured" />

<GitClone id="repo" title="Use the checkout" source="local" prefilledRepoDir="${checkoutDir}" />

<Command id="edit-repo" title="Edit the checkout" path="edit-repo.sh" successMessage="Edited" />
`
}

let tmpDir: string
let runbookDir: string
let userDataDir: string
let env: Record<string, string>
/** The app a test launched, which afterEach quits. */
let running: ElectronApplication | undefined

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, env, stdio: "pipe" })
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
}

/** Every file under `dir`, as sorted paths relative to it. */
function filesOnDisk(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort()
}

test.beforeEach(() => {
  // realpath: macOS tmpdir is a /var symlink, and git reports /private/var.
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-files-panel-e2e-")))
  const home = path.join(tmpDir, "home")
  runbookDir = path.join(tmpDir, "runbook")
  userDataDir = path.join(tmpDir, "user-data")
  const bareDir = path.join(tmpDir, "infra.git")
  const checkoutDir = path.join(tmpDir, "checkout")
  for (const dir of [home, runbookDir, userDataDir]) fs.mkdirSync(dir)

  env = {
    ...(process.env as Record<string, string>),
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Runbooks E2E",
    GIT_AUTHOR_EMAIL: "e2e@example.com",
    GIT_COMMITTER_NAME: "Runbooks E2E",
    GIT_COMMITTER_EMAIL: "e2e@example.com",
    ELECTRON_NO_UPDATER: "1",
    // Skip populateShellEnv so the sandboxed HOME and git env survive.
    TERM_PROGRAM: "runbooks-e2e",
  }

  // A bare repository with one commit, and a checkout of it.
  const seedDir = path.join(tmpDir, "seed")
  fs.mkdirSync(seedDir)
  git(["init", "-q", "-b", "main"], seedDir)
  writeFiles(seedDir, {
    "README.md": "# Infra\n",
    "main.tf": MAIN_TF,
    "old.txt": "remove me\n",
    "modules/vpc/vpc.tf": "# vpc\n",
  })
  git(["add", "."], seedDir)
  git(["commit", "-q", "-m", "init"], seedDir)
  git(["clone", "-q", "--bare", seedDir, bareDir], tmpDir)
  git(["clone", "-q", bareDir, checkoutDir], tmpDir)

  writeFiles(runbookDir, {
    "runbook.mdx": runbookMdx(checkoutDir),
    "capture.sh": CAPTURE_SCRIPT,
    "edit-repo.sh": EDIT_REPO_SCRIPT,
  })
  writeFiles(path.join(runbookDir, "templates", "app"), TEMPLATE_FILES)
})

test.afterEach(async () => {
  await quit()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Launch on the runbook, wait for it to render, and trust it. */
async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    cwd: tmpDir,
    args: [MAIN_ENTRY, MOCK_KEYCHAIN, `--user-data-dir=${userDataDir}`, runbookDir],
    env,
  })
  running = app
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  await resizeMainWindow(app, WINDOW_WIDTH, WINDOW_HEIGHT)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(WINDOW_WIDTH)
  await expect(page.getByRole("heading", { name: "Files panel" })).toBeVisible({
    timeout: 60_000,
  })
  const trustButton = page.getByRole("button", { name: "I trust this Runbook" })
  if (await trustButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await trustButton.click()
    await expect(trustButton).not.toBeVisible({ timeout: 5_000 })
  }
  return { app, page }
}

/** Quit the app, keeping its profile, so the next launch resumes it. */
async function quit(): Promise<void> {
  await running?.close()
  running = undefined
}

/**
 * Text in the Files panel. The narrow layout's copy of the panel stays in the
 * page, hidden, so text matches are limited to what is on screen.
 */
function panelText(page: Page, text: string | RegExp): Locator {
  return page.getByText(text, { exact: true }).filter({ visible: true })
}

/** A file or folder in the panel's file tree, by its name. */
function treeItem(page: Page, name: string): Locator {
  return page.getByRole("treeitem", { name, exact: true })
}

/**
 * A generated file's code in the panel, by its path. A TemplateInline shows
 * its file in the runbook too.
 */
function generatedFile(page: Page, filePath: string): Locator {
  return page
    .getByTestId("filetree-generated")
    .filter({ visible: true })
    .getByTestId(`code-file-${filePath}`)
}

/** A changed repository file's diff, by its path. */
function fileDiff(page: Page, filePath: string): Locator {
  return page.getByTestId(`diff-file-${filePath}`).filter({ visible: true })
}

/** Wait for the panel to finish sliding in. A string, as the e2e specs build without the DOM types. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction("document.getAnimations().length === 0")
}

async function generate(page: Page): Promise<void> {
  await page.getByTestId("app").getByRole("button", { name: "Generate", exact: true }).click()
}

async function run(page: Page, id: string, successMessage: string): Promise<void> {
  const block = page.getByTestId(id)
  await block.getByRole("button", { name: "Run" }).click()
  await expect(block.getByText(successMessage, { exact: true })).toBeVisible({ timeout: 30_000 })
}

/** Register the checkout through the GitClone block's local source. */
async function useCheckout(page: Page): Promise<void> {
  const block = page.getByTestId("repo")
  await expect(block.getByText("Git repository found")).toBeVisible({ timeout: 20_000 })
  await block.getByRole("button", { name: "Use This Repo" }).click()
  await expect(block.getByText("Using local checkout")).toBeVisible({ timeout: 20_000 })
}

test("generated files appear in the tree as blocks write them, and match the folder on disk", async () => {
  const { app, page } = await launch()
  await expect(page.getByRole("treeitem")).toHaveCount(0)

  // A Template's files. Folders start collapsed.
  await generate(page)
  await expect(panelText(page, "3 files generated")).toBeVisible({ timeout: 20_000 })
  await expect(treeItem(page, "README.md")).toBeVisible()
  await expect(treeItem(page, "config")).toBeVisible()
  await expect(treeItem(page, "app.yaml")).toHaveCount(0)

  // A folder expands to its files and collapses again.
  await treeItem(page, "config").click()
  await expect(treeItem(page, "app.yaml")).toBeVisible()
  await expect(treeItem(page, "static.txt")).toBeVisible()
  await treeItem(page, "config").click()
  await expect(treeItem(page, "app.yaml")).toHaveCount(0)

  // TemplateInline: writes its file once its input has a value.
  const note = page.getByTestId("note")
  await note.getByRole("textbox", { name: "Note" }).fill("hello from inline")
  await note.getByRole("button", { name: "Submit" }).click()
  await expect(panelText(page, "4 files generated")).toBeVisible({ timeout: 20_000 })
  await expect(treeItem(page, "notes")).toBeVisible()

  // A Command's $GENERATED_FILES.
  await run(page, "capture", "Captured")
  await expect(panelText(page, "5 files generated")).toBeVisible({ timeout: 20_000 })
  await expect(treeItem(page, "logs")).toBeVisible()

  // The panel's copy button gives the folder on disk, and the panel shows
  // each file in it with its content.
  await runInMain(app, ({ clipboard }) => clipboard.clear(), undefined)
  await page
    .getByRole("button", { name: /^Copy full path/ })
    .filter({ visible: true })
    .click()
  const readClipboard = () => readFromMain(app, ({ clipboard }) => clipboard.readText(), undefined)
  await expect.poll(readClipboard).not.toBe("")
  const outputDir = await readClipboard()
  const expected: Record<string, string> = {
    ...GENERATED_DEFAULT,
    "notes/inline.txt": "hello from inline",
    "logs/run.log": "captured\n",
  }
  expect(filesOnDisk(outputDir)).toEqual(Object.keys(expected).sort())
  for (const [filePath, content] of Object.entries(expected)) {
    expect(fs.readFileSync(path.join(outputDir, filePath), "utf8").trim()).toBe(content.trim())
    const shown = generatedFile(page, filePath)
    for (const line of content.split("\n").filter(Boolean)) {
      await expect(shown).toContainText(line)
    }
  }
})

test("a changed repository file opens to its diff against the committed version", async () => {
  const { page } = await launch()
  await useCheckout(page)
  await run(page, "edit-repo", "Edited")

  await page.getByRole("button", { name: /^Changed files/ }).click()
  await treeItem(page, "main.tf").click()
  const diff = fileDiff(page, "main.tf")
  await expect(diff).toBeVisible({ timeout: 20_000 })
  // The committed line, removed, and the line that replaced it, added.
  await expect(diff.getByRole("row").filter({ hasText: "us-east-1" })).toHaveText(
    /-\s*region = "us-east-1"$/,
  )
  await expect(diff.getByRole("row").filter({ hasText: "eu-west-1" })).toHaveText(
    /\+\s*region = "eu-west-1"$/,
  )

  // Its header folds the diff away and opens it again.
  const header = diff.getByRole("button", { name: /^main\.tf/ })
  await header.click()
  await expect(diff.getByRole("row")).toHaveCount(0)
  await header.click()
  await expect(diff.getByRole("row").filter({ hasText: "eu-west-1" })).toBeVisible()
})

test("the changed files view lists each added, modified and deleted file, and nothing else", async () => {
  const { page } = await launch()
  await useCheckout(page)
  await expect(page.getByRole("button", { name: "Changed files", exact: true })).toBeVisible()

  await run(page, "edit-repo", "Edited")
  const changedTab = page.getByRole("button", { name: "Changed files 3" })
  await expect(changedTab).toBeVisible({ timeout: 20_000 })
  await changedTab.click()

  await expect(page.getByRole("treeitem")).toHaveText(["added.txt", "main.tf", "old.txt"])
  await expect(panelText(page, "3 changed files")).toBeVisible()
  await expect(panelText(page, "+2")).toBeVisible()
  await expect(panelText(page, "-2")).toBeVisible()

  // An added file is all additions, a deleted one all deletions.
  await expect(fileDiff(page, "added.txt").getByRole("row")).toHaveText([/\+\s*new file$/])
  await expect(fileDiff(page, "old.txt").getByRole("row")).toHaveText([/-\s*remove me$/])
})

test("a registered repository shows in the panel, and the panel switches between it and the generated files", async () => {
  const { page } = await launch()
  await generate(page)
  await expect(panelText(page, "3 files generated")).toBeVisible({ timeout: 20_000 })
  // With only generated files there is nothing to switch to.
  await expect(page.getByRole("button", { name: "Repository", exact: true })).toHaveCount(0)

  // Registering the checkout switches the panel to it.
  await useCheckout(page)
  const repository = page.getByRole("button", { name: "Repository", exact: true })
  const generated = page.getByRole("button", { name: "Generated files 3" })
  await expect(repository).toBeVisible({ timeout: 20_000 })
  await expect(generated).toBeVisible()
  await expect(page.getByRole("button", { name: "All files", exact: true })).toBeVisible()
  await expect(treeItem(page, "main.tf")).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole("treeitem")).toHaveText([
    "modules",
    "main.tf",
    "old.txt",
    "README.md",
  ])

  // Its files open to their content, and its folders expand.
  await treeItem(page, "main.tf").click()
  await expect(page.getByTestId("code-file-main.tf").filter({ visible: true })).toContainText(
    'region = "us-east-1"',
  )
  await treeItem(page, "modules").click()
  await expect(treeItem(page, "vpc")).toBeVisible({ timeout: 20_000 })

  await generated.click()
  await expect(panelText(page, "3 files generated")).toBeVisible()
  await expect(treeItem(page, "config")).toBeVisible()
  await expect(treeItem(page, "main.tf")).toHaveCount(0)

  await repository.click()
  await expect(treeItem(page, "main.tf")).toBeVisible()
  await expect(treeItem(page, "config")).toHaveCount(0)
})

const ADDED = "Added since you last reviewed it"
const MODIFIED = "Modified since you last reviewed it"
const HOLDS_CHANGES = "Holds files changed since you last reviewed them"

test("generated files changed since the user reviewed them are marked until reviewed", async () => {
  const { page } = await launch()
  await generate(page)
  await expect(panelText(page, "3 files generated")).toBeVisible({ timeout: 20_000 })

  // Every new file is unreviewed.
  await expect(panelText(page, "3 changed")).toBeVisible()
  await expect(treeItem(page, "README.md")).toHaveAccessibleDescription(ADDED)
  await expect(treeItem(page, "config")).toHaveAccessibleDescription(HOLDS_CHANGES)
  await expect(generatedFile(page, "README.md")).toContainText("Added")

  await page.getByRole("button", { name: "Dismiss all" }).filter({ visible: true }).click()
  await expect(panelText(page, "3 changed")).toHaveCount(0)
  await expect(treeItem(page, "README.md")).toHaveAccessibleDescription("")
  await expect(treeItem(page, "config")).toHaveAccessibleDescription("")

  // A new input value renders the Template again: only the files it changed
  // are marked, with their line counts.
  await page.getByTestId("app").getByRole("textbox", { name: "Name" }).fill("beta")
  await expect(panelText(page, "2 changed")).toBeVisible({ timeout: 20_000 })
  await treeItem(page, "config").click()
  await expect(treeItem(page, "README.md")).toHaveAccessibleDescription(MODIFIED)
  await expect(treeItem(page, "app.yaml")).toHaveAccessibleDescription(MODIFIED)
  await expect(treeItem(page, "static.txt")).toHaveAccessibleDescription("")
  await expect(treeItem(page, "config")).toHaveAccessibleDescription(HOLDS_CHANGES)
  await expect(generatedFile(page, "README.md")).toContainText("Modified +1 -1")

  // A selected file stays marked; it counts as reviewed once the user
  // selects another.
  await treeItem(page, "README.md").click()
  await expect(treeItem(page, "README.md")).toHaveAccessibleDescription(MODIFIED)
  await treeItem(page, "app.yaml").click()
  await expect(treeItem(page, "README.md")).toHaveAccessibleDescription("")
  await expect(treeItem(page, "app.yaml")).toHaveAccessibleDescription(MODIFIED)
  await expect(panelText(page, "1 changed")).toBeVisible()

  // Dismiss on the file reviews it.
  await generatedFile(page, "config/app.yaml")
    .getByRole("button", { name: "Dismiss", exact: true })
    .click()
  await expect(treeItem(page, "app.yaml")).toHaveAccessibleDescription("")
  await expect(treeItem(page, "config")).toHaveAccessibleDescription("")
  await expect(panelText(page, /changed$/)).toHaveCount(0)
})

test("scrolling down past a changed generated file reviews it", async () => {
  const { page } = await launch()
  await generate(page)
  await expect(panelText(page, "3 changed")).toBeVisible({ timeout: 20_000 })

  // The wheel over the files, once the panel has stopped sliding in: a
  // scroll the app or the test makes doesn't count, only the user's.
  await settled(page)
  const box = await generatedFile(page, "README.md").boundingBox()
  if (!box) throw new Error("README.md isn't on screen")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 3_000)
  await expect(panelText(page, /changed$/)).toHaveCount(0, { timeout: 10_000 })
  await expect(treeItem(page, "README.md")).toHaveAccessibleDescription("")
})

/**
 * Drags `handle` `dx` pixels to the right, or to the left when negative.
 *
 * Moves in steps of a quarter of the handle's width, so each move lands on the
 * handle even once it has lost the pointer capture. On the Linux CI runner the
 * X server can send a move with no button held mid-drag, which releases it.
 */
async function drag(page: Page, handle: Locator, dx: number): Promise<void> {
  const box = await handle.boundingBox()
  if (!box) throw new Error("The resize handle isn't on screen")
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: Math.ceil(Math.abs(dx) / (box.width / 4)) })
  await page.mouse.up()
}

function divider(page: Page): Locator {
  return page.getByRole("separator", { name: "Resize the runbook" })
}

async function dividerBox(page: Page): Promise<{ x: number; width: number }> {
  const box = await divider(page).boundingBox()
  if (!box) throw new Error("The divider isn't on screen")
  return box
}

/** Where the divider is across the window, in pixels. */
async function dividerX(page: Page): Promise<number> {
  return (await dividerBox(page)).x
}

/** Show the Files panel beside the runbook, once it has finished sliding in. */
async function showFiles(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Show generated files" }).click()
  await settled(page)
}

test("the divider between the runbook and the panel drags, keeps its place across a relaunch, and resets on double-click", async () => {
  let { page } = await launch()
  await showFiles(page)
  const defaultX = await dividerX(page)

  await drag(page, divider(page), 120)
  await expect.poll(async () => Math.abs((await dividerX(page)) - (defaultX + 120))).toBeLessThan(1)

  await quit()
  page = (await launch()).page
  await showFiles(page)
  expect(Math.abs((await dividerX(page)) - (defaultX + 120))).toBeLessThan(1)

  // The panel keeps at least 25rem (400px): the divider stops short of it.
  await drag(page, divider(page), WINDOW_WIDTH)
  const box = await dividerBox(page)
  expect(WINDOW_WIDTH - (box.x + box.width)).toBeGreaterThanOrEqual(400)

  await divider(page).dblclick()
  await expect.poll(async () => Math.abs((await dividerX(page)) - defaultX)).toBeLessThan(1)

  await quit()
  page = (await launch()).page
  await showFiles(page)
  expect(Math.abs((await dividerX(page)) - defaultX)).toBeLessThan(1)
})
