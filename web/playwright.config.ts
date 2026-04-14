import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // MDX compiles client-side, so give each test enough time for
  // Electron startup + React render + MDX compilation.
  timeout: 30_000,
  reporter: [["list"], ["./e2e/trace-reporter.ts"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // No browser projects — tests launch the Electron app directly via
  // _electron.launch() (see e2e/fixtures.ts).
  // Build the Electron app before running any tests.
  globalSetup: "./e2e/global-setup.ts",
});
