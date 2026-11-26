/**
 * Builds the rebuilt app, packages/app-main (main and the window's preload)
 * and packages/app-renderer, into app-out/. The old app builds from electron.vite.config.ts into dist/, and
 * neither build reads the other's files. `just app-build` and `just app-dev`
 * run this config.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "electron-vite"
import { reactWithCompiler } from "./scripts/vite-react.ts"

const ROOT = import.meta.dirname
const OUT = path.join(ROOT, "app-out")

/** The repository's version, which main is built with: unpackaged, Electron reports its own. */
function appVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
  const version =
    typeof manifest === "object" && manifest !== null && "version" in manifest
      ? manifest.version
      : undefined
  if (typeof version !== "string") throw new Error("package.json has no version.")
  return version
}

export default defineConfig({
  main: {
    define: { __RUNBOOKS_VERSION__: JSON.stringify(appVersion()) },
    build: {
      outDir: path.join(OUT, "main"),
      rolldownOptions: {
        input: { index: path.join(ROOT, "packages/app-main/src/main.ts") },
      },
    },
  },
  preload: {
    build: {
      outDir: path.join(OUT, "preload"),
      rolldownOptions: {
        input: { index: path.join(ROOT, "packages/app-main/src/preload.ts") },
        // A sandboxed preload is a script that may require only electron:
        // CommonJS, with bridge.ts bundled in.
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
          // Rolldown only keeps the sources' own "use strict" directives, and
          // these ES module sources have none, so ask for it as Rollup did.
          strict: true,
        },
      },
    },
  },
  renderer: {
    root: path.join(ROOT, "packages/app-renderer"),
    base: "./",
    plugins: [reactWithCompiler(), tailwindcss()],
    build: {
      outDir: path.join(OUT, "renderer"),
      rolldownOptions: {
        input: { index: path.join(ROOT, "packages/app-renderer/index.html") },
      },
    },
  },
})
