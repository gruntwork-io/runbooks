import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // MDX compiles client-side, so give each test enough time for
  // server startup + React render + MDX compilation.
  timeout: 30_000,
  use: {
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
