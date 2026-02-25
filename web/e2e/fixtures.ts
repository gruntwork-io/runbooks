import { test as base, type ConsoleMessage } from "@playwright/test";
import { type ChildProcess, spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";

const SERVER_PORT = 7825;
const HEALTH_URL = `http://localhost:${SERVER_PORT}/api/health`;
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
function waitForServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;

    function poll() {
      if (Date.now() > deadline) {
        reject(new Error(`Server did not become ready within ${HEALTH_TIMEOUT_MS}ms`));
        return;
      }
      const req = http.get(HEALTH_URL, (res) => {
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
  startServer: (runbookPath: string) => Promise<void>;
  /** Console messages collected from the page during the test. */
  consoleMessages: ConsoleMessage[];
};

/**
 * Extend Playwright's `test` with a `startServer` fixture that manages
 * the Go server lifecycle and a `consoleMessages` array for assertions.
 */
export const test = base.extend<RunbookServerFixture>({
  // eslint-disable-next-line no-empty-pattern
  consoleMessages: async ({}, use) => {
    const messages: ConsoleMessage[] = [];
    await use(messages);
  },

  startServer: async ({ page, consoleMessages }, use) => {
    let serverProcess: ChildProcess | null = null;

    // Collect all browser console messages for later assertion.
    page.on("console", (msg) => consoleMessages.push(msg));

    const start = async (runbookPath: string) => {
      serverProcess = spawn(BINARY_PATH, ["serve", runbookPath], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // Create a process group so we can kill the whole tree.
        env: {
          ...process.env,
          // Disable telemetry during tests.
          RUNBOOKS_TELEMETRY_DISABLE: "1",
        },
      });

      // Log server stderr for debugging test failures.
      serverProcess.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          // Only log actual errors, skip Gin's routine request logs.
          if (!line.includes("[GIN]") && !line.includes("200 |")) {
            console.error(`[server stderr] ${line}`);
          }
        }
      });

      await waitForServer();
    };

    await use(start);

    // Teardown: kill the server process.
    if (serverProcess) {
      await killProcess(serverProcess);
    }
  },
});

export { expect } from "@playwright/test";
