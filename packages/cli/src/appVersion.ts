/**
 * This build's version, the app's: the CLI ships with the app. `main.ts`
 * imports it as a Bun macro, so it is read from the repository's
 * `package.json` when the entry point is transpiled, and a compiled binary
 * carries the string, not the file.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

export function appVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(path.resolve(import.meta.dir, "../../../package.json"), "utf8"),
  )
  const version =
    typeof manifest === "object" && manifest !== null && "version" in manifest
      ? manifest.version
      : undefined
  if (typeof version !== "string") throw new Error("package.json has no version.")
  return version
}
