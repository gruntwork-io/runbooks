/// <reference types="vitest" />
import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import { assertNoNestedNodeModules } from "../scripts/no-nested-node-modules.ts"

// A leftover web/node_modules would take precedence over the root tree for
// these tests.
assertNoNestedNodeModules(path.resolve(__dirname, ".."))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["**/*.test.*", "e2e/**", "**/test/**"],
    },
  },
})
