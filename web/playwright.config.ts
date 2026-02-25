import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Tests run serially because the server uses a fixed port (7825).
  // Phase 2: add --port flag to CLI and increase workers.
  workers: 1,
  // MDX compiles client-side, so give each test enough time for
  // server startup + React render + MDX compilation.
  timeout: 30_000,
  use: {
    // All tests connect to the Go backend on the default port.
    baseURL: "http://localhost:7825",
    // Capture traces and screenshots only on failure to aid debugging.
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // Build the Go binary before running any tests.
  globalSetup: "./e2e/global-setup.ts",
});
