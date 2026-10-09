/// <reference types="vitest" />
import path from "path"
import { defineConfig } from "vite"
import { assertNoNestedNodeModules } from "../scripts/no-nested-node-modules.ts"
import { reactWithCompiler } from "../scripts/vite-react.ts"

// A leftover web/node_modules would take precedence over the root tree for
// these tests.
assertNoNestedNodeModules(path.resolve(__dirname, ".."))

export default defineConfig({
  plugins: [reactWithCompiler()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    // Resolved from this file so the root vitest.config.ts, which re-exports
    // this config, finds it too.
    setupFiles: [path.resolve(__dirname, "./src/test/setup.ts")],
    exclude: ["e2e/**", "node_modules/**"],
  },
})
