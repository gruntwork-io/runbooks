import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // No browser projects needed — Electron tests launch the app directly
  // via _electron.launch() rather than connecting to a browser.
})
