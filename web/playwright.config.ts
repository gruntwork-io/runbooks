import { defineConfig } from "@playwright/test"
import { fileURLToPath } from "url"
import { assertNoNestedNodeModules } from "../scripts/no-nested-node-modules.ts"

// The specs in web/e2e/ resolve @playwright/test from web/, so a leftover
// web/node_modules would take precedence over the root copy.
assertNoNestedNodeModules(fileURLToPath(new URL("..", import.meta.url)))

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
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
})
