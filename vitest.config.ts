/// <reference types="vitest" />
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    include: [
      "src/**/*.test.ts",
      "electron/**/*.test.ts",
    ],
    exclude: ["node_modules/**", "web/**", "docs/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts", "electron/**/*.ts"],
      exclude: ["**/*.test.ts", "**/test-utils/**"],
    },
  },
})
