import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./electron/e2e",
  // Only `*.spec.ts`: the frozen baseline lists the e2e specs by that name.
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
})
