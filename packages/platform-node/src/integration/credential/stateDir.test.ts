/** `prepareStateDir` against the real filesystem, where the modes are the OS's. */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Result } from "effect"
import { prepareStateDir } from "@runbooks/core/credential/stateDir"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"

let root = ""
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "runbooks-state-")))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const prepare = (dir: string) =>
  Effect.runPromise(Effect.result(prepareStateDir(dir)).pipe(Effect.provide(NodeFileSystemLive)))

const modeOf = (dir: string) => statSync(dir).mode & 0o777

describe("a credential block's state folder, on disk", () => {
  it("is made, with the session's folder above it, readable by its owner only", async () => {
    const dir = path.join(root, "state", "s1", "cloud")
    expect(Result.isSuccess(await prepare(dir))).toBe(true)
    expect([modeOf(path.join(root, "state", "s1")), modeOf(dir)]).toEqual([0o700, 0o700])
  })

  it("is taken back when a resumed session finds it owner-only, and refused when others can read it", async () => {
    const dir = path.join(root, "cloud")
    mkdirSync(dir, { mode: 0o700 })
    expect(Result.isSuccess(await prepare(dir))).toBe(true)
    chmodSync(dir, 0o755)
    const refused = await prepare(dir)
    expect(Result.isFailure(refused) && refused.failure.kind).toBe("providerFailed")
    expect(modeOf(dir)).toBe(0o755)
  })
})
