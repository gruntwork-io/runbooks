import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  timeout: 90_000,
  // Electron e2e tests launch the real app, which holds a single-instance
  // lock — parallel workers make later launches quit immediately.
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // No browser projects needed — Electron tests launch the app directly
  // via _electron.launch() rather than connecting to a browser.
})
