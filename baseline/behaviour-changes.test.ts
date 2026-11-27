import { afterAll, describe, expect, it } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadConfig } from "../cli/test/config.ts"
import { E2E_SPECS, FIXTURES, STEP_0_E2E_SPECS } from "./baseline.ts"
import { CHANGES, filesIn, PATCH_DIR, PATCHES, patchFiles } from "./behaviour-changes.ts"

const ROOT = path.resolve(import.meta.dir, "..")
const work = mkdtempSync(path.join(tmpdir(), "behaviour-changes-"))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const sorted = (items: Iterable<string>) => [...items].sort((a, b) => a.localeCompare(b))

/** The fixture folders and specs a patch may touch, plus the fixture the e2e specs open. */
const BASELINE_FILES = [
  ...FIXTURES.map((f) => `${path.dirname(f)}/`),
  "testdata/kitchen-sink/",
  ...E2E_SPECS,
  ...STEP_0_E2E_SPECS,
]

/** Applies one patch to a copy of the files it touches, in a folder of its own. */
function apply(patch: string): { dir: string; status: number; stderr: string } {
  const dir = path.join(work, patch)
  for (const file of filesIn(patch)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    copyFileSync(path.join(ROOT, file), path.join(dir, file))
  }
  const result = Bun.spawnSync(["git", "apply", path.join(PATCH_DIR, patch)], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: work, GIT_CONFIG_NOSYSTEM: "1" },
  })
  return { dir, status: result.exitCode, stderr: result.stderr.toString() }
}

describe("the behaviour changes, against today's tree", () => {
  it("lists every patch on disk, and only those", () => {
    expect(patchFiles()).toEqual(sorted(Object.keys(PATCHES)))
  })

  it("pins each of the twelve changes with a patch, or says why nothing relies on it", () => {
    const pinned = new Set(Object.values(PATCHES).flat())
    expect(Object.keys(CHANGES)).toHaveLength(12)
    const neither = Object.entries(CHANGES)
      .filter(
        ([id, change]) =>
          pinned.has(id as keyof typeof CHANGES) === (change.unpinned !== undefined),
      )
      .map(([id]) => id)
    expect(neither).toEqual([])
  })

  it("touches only baseline fixtures and e2e specs", () => {
    const outside = patchFiles().flatMap((patch) =>
      filesIn(patch)
        .filter(
          (file) => !BASELINE_FILES.some((allowed) => file === allowed || file.startsWith(allowed)),
        )
        .map((file) => `${patch}: ${file}`),
    )
    expect(outside).toEqual([])
  })

  for (const patch of patchFiles()) {
    it(`${patch} applies, and leaves each runbook_test.yml loadable`, () => {
      const { dir, status, stderr } = apply(patch)
      expect(stderr).toBe("")
      expect(status).toBe(0)
      for (const file of filesIn(patch).filter((f) => f.endsWith("runbook_test.yml"))) {
        expect(loadConfig(path.join(dir, file)).tests.length).toBeGreaterThan(0)
      }
    })
  }
})
