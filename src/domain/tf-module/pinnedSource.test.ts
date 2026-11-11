import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { ChildProcessSpawnerLive } from "../../layers/ChildProcessSpawner.ts"
import { gitSourceAddress, localModuleSource, remoteModuleSource } from "./pinnedSource.ts"

const run = async <A, E>(effect: Effect.Effect<A, E, never>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return { value: exit.value }
  return { error: (Cause.squash(exit.cause) as Error).message }
}
const local = (dir: string) =>
  run(localModuleSource(dir).pipe(Effect.provide(ChildProcessSpawnerLive)))
const remote = (source: string, dir: string) =>
  run(remoteModuleSource(source, dir).pipe(Effect.provide(ChildProcessSpawnerLive)))

describe("gitSourceAddress", () => {
  it("writes https and scp-like remotes as Git sources, without credentials", () => {
    expect(gitSourceAddress("https://x-access-token:abc@github.com/acme/catalog.git")).toBe(
      "git::https://github.com/acme/catalog.git",
    )
    expect(gitSourceAddress("git@github.com:acme/catalog.git")).toBe(
      "git::ssh://git@github.com/acme/catalog.git",
    )
    expect(gitSourceAddress("/srv/catalog.git")).toBeUndefined()
  })
})

describe("the source code in a repository points at", () => {
  let repo: string
  const moduleDir = () => path.join(repo, "modules", "group")
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: repo,
    })

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pinned-"))
    git("init", "-q", "-b", "main")
    fs.mkdirSync(moduleDir(), { recursive: true })
    fs.writeFileSync(path.join(moduleDir(), "variables.tf"), 'variable "name" {}\n')
    git("add", "-A")
    git("commit", "-q", "-m", "module")
    git("remote", "add", "origin", "https://github.com/acme/catalog.git")
  })
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

  it("is the runbook's repository at the tag its checkout is at", async () => {
    git("tag", "v1.2.0")
    expect(await local(moduleDir())).toEqual({
      value: "git::https://github.com/acme/catalog.git//modules/group?ref=v1.2.0",
    })
  })

  it("is refused, naming the ref, when the checkout isn't at a tag", async () => {
    const { error } = await local(moduleDir())
    expect(error).toContain("open at the branch main, which isn't a tag")
  })

  it("is refused when the module has changes the tag doesn't", async () => {
    git("tag", "v1.2.0")
    fs.writeFileSync(path.join(moduleDir(), "main.tf"), "# new\n")
    const { error } = await local(moduleDir())
    expect(error).toContain("changes that aren't in v1.2.0")
  })

  it("keeps a remote source whose ref is a tag, and refuses one whose ref isn't", async () => {
    git("tag", "v1.2.0")
    const tagged = "git::https://github.com/acme/catalog.git//modules/group?ref=v1.2.0"
    expect(await remote(tagged, moduleDir())).toEqual({ value: tagged })
    const branch = "git::https://github.com/acme/catalog.git//modules/group?ref=main"
    expect((await remote(branch, moduleDir())).error).toContain("main, isn't a tag")
    const unpinned = "git::https://github.com/acme/catalog.git//modules/group"
    expect((await remote(unpinned, moduleDir())).error).toContain("has no ?ref=")
  })
})
