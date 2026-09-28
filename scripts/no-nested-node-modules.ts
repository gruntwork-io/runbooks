// Fail fast if web/ or cli/ holds packages from an old per-directory install.
//
// Neither directory has a package.json any more; all dependencies come from the
// root node_modules. A leftover web/node_modules or cli/node_modules would still
// shadow the root tree for imports from that directory (Node, Bun, Vite and tsc
// all resolve the nearest node_modules first), silently giving stale versions or
// two copies of react/effect. Entries starting with "." (.vite, .vite-temp,
// .tmp) are tool caches, not packages, so they are allowed.
//
// Called from electron.vite.config.ts, web/vitest.config.ts and
// web/playwright.config.ts, so `bun run dev|build|test:web|test:e2e` and a bare
// `bunx electron-vite`/`bunx vitest`/`bunx playwright` on web/ are guarded.
// Run directly (`bun scripts/no-nested-node-modules.ts`) by the justfile's
// _no-nested-node-modules recipe and by every other package.json script that
// type-checks or runs tests: typecheck, test, test:backend, test:watch,
// test:coverage, test:integration and test:electron-e2e, so every entry point
// asks for the same one-time cleanup.
import { readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const NESTED = ["web/node_modules", "cli/node_modules"]

export function assertNoNestedNodeModules(repoRoot: string): void {
  const found = NESTED.filter((rel) => {
    let entries: string[]
    try {
      entries = readdirSync(path.join(repoRoot, rel))
    } catch {
      return false // absent (the normal case) or not a directory
    }
    return entries.some((name) => !name.startsWith("."))
  })
  if (found.length === 0) return

  throw new Error(
    found.map((dir) => `${dir} contains packages from an old per-directory install.`).join("\n") +
      `\nAll dependencies now come from the root node_modules. Remove ${found.length > 1 ? "them" : "it"}: rm -rf ${found.join(" ")}`,
  )
}

// import.meta.url rather than Bun's import.meta.dir, so `node` can run it too.
if (import.meta.main) {
  try {
    assertNoNestedNodeModules(fileURLToPath(new URL("..", import.meta.url)))
  } catch (err) {
    console.error(`error: ${(err as Error).message}`)
    process.exit(1)
  }
}
