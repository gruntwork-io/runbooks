import { test as base, expect, type ConsoleMessage } from "@playwright/test";
import { type ChildProcess, spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";

// This is the default port for the serve command, and we increment it for each parallel worker.
const BASE_PORT = 7825;
const HEALTH_POLL_INTERVAL_MS = 100;
const HEALTH_TIMEOUT_MS = 10_000;

/** Repo root: two directories above web/e2e/ */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Resolved path to the Go binary at the repo root. */
const BINARY_PATH = path.join(REPO_ROOT, "runbooks");

/**
 * Poll the /api/health endpoint until the server reports "ok".
 * Mirrors the Go `waitForServerReady` logic in cmd/server.go.
 */
function waitForServer(port: number): Promise<void> {
  const healthURL = `http://localhost:${port}/api/health`;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;

    function poll() {
      if (Date.now() > deadline) {
        reject(new Error(`Server did not become ready within ${HEALTH_TIMEOUT_MS}ms`));
        return;
      }
      const req = http.get(healthURL, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(body);
              if (json.status === "ok") {
                resolve();
                return;
              }
            } catch {
              // Not valid JSON yet — keep polling.
            }
          }
          setTimeout(poll, HEALTH_POLL_INTERVAL_MS);
        });
      });
      req.on("error", () => setTimeout(poll, HEALTH_POLL_INTERVAL_MS));
    }

    poll();
  });
}

/** Kill a process tree. Sends SIGTERM, then SIGKILL after a short grace period. */
function killProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!proc.pid) {
      resolve();
      return;
    }
    // Kill process group (negative PID) to clean up child processes.
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      // Process may have already exited.
    }
    const timeout = setTimeout(() => {
      try {
        process.kill(-proc.pid!, "SIGKILL");
      } catch {
        // Already exited.
      }
    }, 2_000);
    proc.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    // If the process already exited, resolve immediately.
    if (proc.exitCode !== null) {
      clearTimeout(timeout);
      resolve();
    }
  });
}

// ---- Custom fixture types ------------------------------------------------

type RunbookServerFixture = {
  /**
   * Start the runbooks server for the given runbook path.
   * The path should be relative to the repo root (e.g. "testdata/sample-runbooks/my-first-runbook").
   */
  serveRunbook: (runbookPath: string) => Promise<void>;
  /** The port the server is listening on (unique per parallel worker). */
  serverPort: number;
  /** Console messages collected from the page during the test. */
  consoleMessages: ConsoleMessage[];
};

/**
 * Extend Playwright's `test` with a `serveRunbook` fixture that manages
 * the Go server lifecycle and a `consoleMessages` array for assertions.
 *
 * Each parallel worker gets a unique port (BASE_PORT + workerIndex) so
 * multiple tests can run simultaneously without port conflicts.
 */
export const test = base.extend<RunbookServerFixture>({
  // eslint-disable-next-line no-empty-pattern
  consoleMessages: async ({}, use) => {
    const messages: ConsoleMessage[] = [];
    await use(messages);
  },

  serverPort: [async ({}, use, testInfo) => {
    await use(BASE_PORT + testInfo.workerIndex);
  }, { scope: "test" }],

  serveRunbook: async ({ page, consoleMessages, serverPort }, use) => {
    let serverProcess: ChildProcess | null = null;

    page.on("console", (msg) => consoleMessages.push(msg));

    const start = async (runbookPath: string) => {
      serverProcess = spawn(
        BINARY_PATH,
        ["serve", "--port", String(serverPort), runbookPath],
        {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          env: {
            ...process.env,
            RUNBOOKS_TELEMETRY_DISABLE: "1",
          },
        },
      );

      serverProcess.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          if (!line.includes("[GIN]") && !line.includes("200 |")) {
            console.log(`[server:${serverPort}] ${line}`);
          }
        }
      });

      const earlyExit = new Promise<never>((_, reject) => {
        serverProcess!.on("exit", (code) => {
          reject(new Error(`Server exited with code ${code} before becoming ready (runbook path: ${runbookPath})`));
        });
      });

      await Promise.race([waitForServer(serverPort), earlyExit]);
    };

    await use(start);

    if (serverProcess) {
      await killProcess(serverProcess);
    }
  },
});

export { expect } from "@playwright/test";

export type { Page } from "@playwright/test";

/**
 * If the "Existing Generated Files Detected" dialog appears, click
 * "Delete Files" and wait for it to close. Otherwise do nothing.
 * Call this after page.goto() for runbooks that generate files.
 *
 * Waits up to 2 seconds for the dialog to appear (it renders
 * asynchronously after an API call), then proceeds immediately
 * if it never shows.
 */
export async function deleteFilesIfPrompted(page: import("@playwright/test").Page) {
  const dialog = page.getByTestId("delete-files-alert");
  try {
    await dialog.waitFor({ state: "visible", timeout: 2_000 });
  } catch {
    return;
  }

  await dialog.getByRole("button", { name: "Delete Files" }).click();
  await expect(dialog).not.toBeVisible({ timeout: 3_000 });
}

/**
 * Dismiss the "I trust this Runbook" confirmation banner.
 * Call this before any test that needs to execute commands or interact with
 * blocks that require trust (e.g. Command, Check).
 */
export async function trustRunbook(page: import("@playwright/test").Page) {
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
