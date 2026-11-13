import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { ChildProcessSpawnerLive } from "../../layers/ChildProcessSpawner.ts"
import { modulePage } from "./modulePage.ts"

const page = (source: string, dir: string) =>
  Effect.runPromise(modulePage(source, dir).pipe(Effect.provide(ChildProcessSpawnerLive)))

describe("modulePage", () => {
  let repo: string
  const moduleDir = () => path.join(repo, "modules", "group")
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: repo,
    })
      .toString()
      .trim()

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "tf-page-"))
    git("init", "-q", "-b", "main")
    fs.mkdirSync(moduleDir(), { recursive: true })
    fs.writeFileSync(path.join(moduleDir(), "variables.tf"), 'variable "name" {}\n')
    git("add", "-A")
    git("commit", "-q", "-m", "module")
  })
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

  it("is a remote source's folder on GitHub at its ref", async () => {
    expect(
      await page("git::https://github.com/acme/catalog.git//modules/group?ref=v1.4.0", moduleDir()),
    ).toBe("https://github.com/acme/catalog/tree/v1.4.0/modules/group")
  })

  it("is a local module's folder in its repository on GitHub, at the tag its checkout is at", async () => {
    git("remote", "add", "origin", "git@github.com:acme/catalog.git")
    git("tag", "v1.2.0")
    expect(await page("../../modules/group", moduleDir())).toBe(
      "https://github.com/acme/catalog/tree/v1.2.0/modules/group",
    )
  })

  it("is at the checkout's commit when it isn't at a tag", async () => {
    git("remote", "add", "origin", "https://github.com/acme/catalog.git")
    const commit = git("rev-parse", "HEAD")
    expect(await page("../../modules/group", moduleDir())).toBe(
      `https://github.com/acme/catalog/tree/${commit}/modules/group`,
    )
  })

  it("is nothing when the repository has no origin, or it isn't on GitHub", async () => {
    expect(await page("../../modules/group", moduleDir())).toBeUndefined()
    git("remote", "add", "origin", "https://gitlab.com/acme/catalog.git")
    expect(await page("../../modules/group", moduleDir())).toBeUndefined()
  })
})
