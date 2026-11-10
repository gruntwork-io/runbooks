import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { ChildProcessSpawnerLive } from "../../layers/ChildProcessSpawner.ts"
import { filesAtBase as filesAtBaseEffect } from "./repoFiles.ts"

const filesAtBase = (...args: Parameters<typeof filesAtBaseEffect>) =>
  Effect.runPromise(filesAtBaseEffect(...args).pipe(Effect.provide(ChildProcessSpawnerLive)))

describe("filesAtBase", () => {
  let repo: string
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: repo,
    })
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), content)
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "tofu-repo-"))
    git("init", "-q", "-b", "main")
    write("root.hcl", "root\n")
    write("prod/account.hcl", "account\n")
    write("prod/eng/terragrunt.hcl", "old\n")
    write("prod/eng/deeper/x.hcl", "not in a folder above")
    git("add", "-A")
    git("commit", "-q", "-m", "base")
  })
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

  it("reads the base branch, not what the checkout holds now", async () => {
    write("prod/eng/terragrunt.hcl", "written by a plan")
    git("checkout", "-q", "-b", "runbooks/eng")
    git("commit", "-q", "-am", "pull request")
    const files = await filesAtBase(repo, "main", ["", "prod"], ["prod/eng/terragrunt.hcl"])
    expect(Object.fromEntries(files)).toEqual({
      "prod/account.hcl": "account\n",
      "prod/eng/terragrunt.hcl": "old\n",
      "root.hcl": "root\n",
    })
  })

  it("falls back to HEAD when the base branch isn't there", async () => {
    const files = await filesAtBase(repo, "trunk", [""], [])
    expect([...files]).toEqual([["root.hcl", "root\n"]])
  })

  it("holds nothing in a repository with no commits", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tofu-repo-"))
    try {
      execFileSync("git", ["init", "-q"], { cwd: empty })
      expect((await filesAtBase(empty, "main", [""], ["a/b.hcl"])).size).toBe(0)
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })
})
