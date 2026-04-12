import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./electron/e2e",
  timeout: 90_000,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
})
