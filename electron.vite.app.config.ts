/**
 * Builds the rebuilt app, packages/app-main and packages/app-renderer, into
 * app-out/. The old app builds from electron.vite.config.ts into dist/, and
 * neither build reads the other's files. `just app-build` and `just app-dev`
 * run this config.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
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
  renderer: {
    root: path.join(ROOT, "packages/app-renderer"),
    base: "./",
    plugins: [reactWithCompiler()],
    build: {
      outDir: path.join(OUT, "renderer"),
      rolldownOptions: {
        input: { index: path.join(ROOT, "packages/app-renderer/index.html") },
      },
    },
  },
})
