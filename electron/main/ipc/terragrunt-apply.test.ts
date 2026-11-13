/** What a <TerragruntApply> block counts as pushed, and as a change to a planned unit. */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mockElectron } from "../test-utils/mock-electron.ts"

mockElectron({ ipcMain: { handle: () => {} } })
const { unpushedChanges, fingerprintOf, identityOf } = await import("./terragrunt-apply.ts")
const { runtime } = await import("./runtime.ts")

let root: string
let clone: string
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  })
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(clone, file)), { recursive: true })
  fs.writeFileSync(path.join(clone, file), content)
}
const unit = () => path.join(clone, "aws/prod/budget")

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "terragrunt-apply-"))
  git(root, "init", "-q", "--bare", "remote.git")
  git(root, "clone", "-q", "remote.git", "clone")
  clone = path.join(root, "clone")
  write("root.hcl", "remote_state {}\n")
  write("aws/prod/budget/terragrunt.hcl", "inputs = {}\n")
  git(clone, "add", ".")
  git(clone, "commit", "-qm", "unit")
  git(clone, "push", "-q", "origin", "HEAD")
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe("unpushedChanges", () => {
  const check = () => runtime.runPromise(unpushedChanges(clone))

  it("finds nothing when the clone's commit is on its remote", async () => {
    expect(await check()).toBeUndefined()
  })

  it("names a change that isn't committed", async () => {
    write("aws/prod/budget/terragrunt.hcl", "inputs = { limit = 10 }\n")
    expect(await check()).toContain("aws/prod/budget/terragrunt.hcl")
  })

  it("names a commit that isn't pushed", async () => {
    write("aws/prod/budget/terragrunt.hcl", "inputs = { limit = 10 }\n")
    git(clone, "commit", "-qam", "limit")
    expect(await check()).toContain("isn't on any branch of its remote")
  })

  it("leaves out the lock file a plan writes", async () => {
    write("aws/prod/budget/.terraform.lock.hcl", "# lock\n")
    expect(await check()).toBeUndefined()
  })
})

describe("identityOf", () => {
  it("changes with the auth blocks' env vars, not their order", () => {
    const signedIn = { AWS_ACCESS_KEY_ID: "AKIA1", AWS_SECRET_ACCESS_KEY: "s1" }
    expect(identityOf(signedIn)).toBe(
      identityOf({ AWS_SECRET_ACCESS_KEY: "s1", AWS_ACCESS_KEY_ID: "AKIA1" }),
    )
    expect(identityOf({ ...signedIn, AWS_ACCESS_KEY_ID: "AKIA2" })).not.toBe(identityOf(signedIn))
    expect(identityOf({ A: "b\0c" })).not.toBe(identityOf({ A: "b", c: "" }))
  })
})

describe("fingerprintOf", () => {
  const fingerprint = () => runtime.runPromise(fingerprintOf(clone, unit()))

  it("changes with the unit's files and the .hcl files above it", async () => {
    const before = await fingerprint()
    write("aws/prod/budget/terragrunt.hcl", "inputs = { limit = 10 }\n")
    const edited = await fingerprint()
    expect(edited).not.toBe(before)
    write("root.hcl", 'remote_state { bucket = "other" }\n')
    expect(await fingerprint()).not.toBe(edited)
  })

  it("doesn't change with what Terragrunt downloads or other folders' files", async () => {
    const before = await fingerprint()
    write("aws/prod/budget/.terragrunt-cache/x/main.tf", "")
    write("aws/staging/budget/terragrunt.hcl", "inputs = {}\n")
    write("README.md", "")
    expect(await fingerprint()).toBe(before)
  })
})
