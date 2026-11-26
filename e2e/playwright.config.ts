import { defineConfig } from "@playwright/test"

/**
 * The rebuilt app's e2e specs. Each launches the build in app-out/ (`just
 * app-build`) with a user data folder of its own, so they run in parallel.
 * The old app's specs have their own configs.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
})
