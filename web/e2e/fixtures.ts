import {
  test as base,
  expect,
  _electron as electron,
  type ConsoleMessage,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

/** Repo root: two directories above web/e2e/ */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Entry point of the built Electron app. Produced by `electron-vite build`. */
const MAIN_ENTRY = path.join(REPO_ROOT, "dist", "main", "index.js");

// ---- Custom fixture types ------------------------------------------------

type RunbookAppFixture = {
  /**
   * Launch the Electron app with the given runbook and return its first
   * window. The runbook path may be absolute or relative to the repo root.
   * The app is automatically closed at the end of the test.
   */
  launchRunbook: (runbookPath: string) => Promise<Page>;
  /** Console messages collected from the page during the test. */
  consoleMessages: ConsoleMessage[];
  /** Temporary working directory forwarded to the app via --working-dir. */
  workDir: string;
};

/**
 * Extend Playwright's `test` with a `launchRunbook` fixture that manages
 * the Electron app lifecycle and a `consoleMessages` array for assertions.
 *
 * Each test gets its own temp `workDir` so generated files are isolated.
 */
export const test = base.extend<RunbookAppFixture>({
  // eslint-disable-next-line no-empty-pattern
  consoleMessages: async ({}, use) => {
    const messages: ConsoleMessage[] = [];
    await use(messages);
  },

  workDir: [async ({}, use, testInfo) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `runbooks-e2e-${testInfo.workerIndex}-`));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }, { scope: "test" }],

  launchRunbook: async ({ consoleMessages, workDir }, use) => {
    let app: ElectronApplication | null = null;

    const launch = async (runbookPath: string): Promise<Page> => {
      const absRunbookPath = path.isAbsolute(runbookPath)
        ? runbookPath
        : path.join(REPO_ROOT, runbookPath);

      app = await electron.launch({
        // --no-sandbox is required on Linux CI (Ubuntu 24.04+) where AppArmor
        // blocks unprivileged user namespaces and chrome-sandbox isn't SUID.
        args: [MAIN_ENTRY, "--no-sandbox", "--working-dir", workDir, absRunbookPath],
        env: {
          ...process.env,
          ELECTRON_NO_UPDATER: "1",
          RUNBOOKS_TELEMETRY_DISABLE: "1",
          RUNBOOKS_NO_TELEMETRY: "1",
        },
      });

      const page = await app.firstWindow();
      page.on("console", (msg) => consoleMessages.push(msg));
      await page.waitForLoadState("domcontentloaded");
      return page;
    };

    await use(launch);

    if (app) {
      await app.close();
    }
  },
});

export { expect } from "@playwright/test";

export type { Page } from "@playwright/test";

/**
 * If the "Existing Generated Files Detected" dialog appears, click
 * "Delete Files" and wait for it to close. Otherwise do nothing.
 * Call this after launchRunbook() for runbooks that generate files.
 *
 * Waits up to 2 seconds for the dialog to appear (it renders
 * asynchronously after an API call), then proceeds immediately
 * if it never shows.
 */
export async function deleteFilesIfPrompted(page: Page) {
  const dialog = page.getByTestId("delete-files-alert");
  try {
    await dialog.waitFor({ state: "visible", timeout: 2_000 });
  } catch {
    return;
  }

  await dialog.getByRole("button", { name: "Delete Files" }).click();
  await expect(dialog).not.toBeVisible({ timeout: 3_000 });
}

// ---- Workspace file panel helpers -----------------------------------------

type FilesPanelType = 'generated' | 'all' | 'changed';

const PANEL_TEST_IDS: Record<FilesPanelType, string> = {
  generated: 'filetree-generated',
  all: 'filetree-all',
  changed: 'filetree-changed',
};

/**
 * Returns scoped locators for a workspace file panel.
 *
 * The app renders both a desktop and a mobile ArtifactsContainer with
 * identical test IDs, so we use `:visible` to target the active one.
 *
 * @example
 * ```ts
 * const gen = getFilesPanel(page, 'generated');
 * await gen.getTreeItem('subfolder').click();
 * await expect(gen.getCodeFile('.mise.toml')).toContainText('opentofu = "1"');
 * ```
 */
export function getFilesPanel(page: Page, panel: FilesPanelType) {
  const root = page.locator(`[data-testid="${PANEL_TEST_IDS[panel]}"]:visible`);

  return {
    /** The root locator for the panel — use for custom queries. */
    root,
    /** Locator for a tree item (file or folder) by exact display name. */
    getTreeItem: (name: string) => root.getByRole("treeitem", { name, exact: true }),
    /** Locator for a rendered code file by its path (matches `data-testid="code-file-<path>"`). */
    getCodeFile: (filePath: string) => root.getByTestId(`code-file-${filePath}`),
  };
}

/**
 * Dismiss the "I trust this Runbook" confirmation banner.
 * Call this before any test that needs to execute commands or interact with
 * blocks that require trust (e.g. Command, Check).
 */
export async function trustRunbook(page: Page) {
  await page.getByRole("button", { name: "I trust this Runbook" }).click();
}

/**
 * Assert that no unexpected console errors occurred during a test.
 * Filters out the expected 401 from /api/session/join (the frontend
 * tries to join an existing session first, and handles the 401 by
 * creating a new one).
 */
export function expectNoConsoleErrors(messages: ConsoleMessage[]) {
  const unexpected = messages
    .filter((m) => m.type() === "error" && !m.location().url.includes("/api/session/join"))
    .map((m) => ({
      text: m.text(),
      url: m.location().url,
    }));

  if (unexpected.length > 0) {
    const summary = unexpected
      .map((e, i) => `  ${i + 1}. ${e.text}\n     Source: ${e.url}`)
      .join("\n\n");
    expect.soft(unexpected, `Browser console errors:\n\n${summary}\n`).toHaveLength(0);
  }
}

/**
 * Create a local bare git repo with one commit, suitable for cloning
 * in tests without needing GitHub credentials or network access.
 *
 * Returns the absolute path to the bare repo (use as a `file://` URL).
 */
export function createLocalBareRepo(parentDir: string, name = "bare-test-repo"): string {
  const bareRepoPath = path.join(parentDir, `${name}.git`);
  execSync(`git init --bare "${bareRepoPath}"`, { stdio: "ignore" });

  const seedDir = path.join(parentDir, `_seed-${name}`);
  execSync([
    `git init "${seedDir}"`,
    `cd "${seedDir}"`,
    `git checkout -b main`,
    `echo "hello" > README.md`,
    `git add .`,
    `git -c user.name=test -c user.email=test@test.com commit -m "init"`,
    `git remote add origin "${bareRepoPath}"`,
    `git push origin main`,
  ].join(" && "), { stdio: "ignore" });
  fs.rmSync(seedDir, { recursive: true, force: true });

  return bareRepoPath;
}
