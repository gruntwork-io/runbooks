import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mockElectron } from "../test-utils/mock-electron.ts"

// git.ts registers its handlers on electron's ipcMain. Capture them so the
// real git:clone handler can be called directly; the rest of the stack
// (Effect runtime, session, process spawning, git itself) is the live one.
// Only ssh is replaced: a stand-in on PATH logs its arguments and serves the
// repositories under a local directory.
type Handler = (event: unknown, params: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
mockElectron({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
  },
})

const { registerGitHandlers } = await import("./git.ts")
const { runtime, sessionManager } = await import("./runtime.ts")

// git runs ssh as: ssh [options] [-p port] <user@host> <command>. One log
// line per ssh run.
const FAKE_SSH = `#!/bin/sh
echo "$@" >> "$FAKE_SSH_LOG"
for arg; do command=$arg; done
cd "$FAKE_SSH_ROOT" && exec sh -c "$command"
`

// The user's own ssh command, as core.sshCommand (set through GIT_CONFIG_* so
// no config file is written), and what every ssh run must be started with.
const USER_SSH_COMMAND = "ssh -i /keys/id_work"
const BATCH_SSH_ARGS = "-i /keys/id_work -o BatchMode=yes -o StrictHostKeyChecking=yes"

const SANDBOX_VARS = [
  "HOME",
  "PATH",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "FAKE_SSH_LOG",
  "FAKE_SSH_ROOT",
] as const

let tmpDir = ""
let workDir = ""
let sshLog = ""
const originalEnv: Record<string, string | undefined> = {}

// `env: process.env` because bun's child_process otherwise starts git with the
// environment the test process began with, not the sandbox set up below.
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "pipe",
    env: process.env,
  })

beforeAll(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-clone-ssh-")))
  workDir = path.join(tmpDir, "work")
  fs.mkdirSync(workDir)

  // git runs with a sandboxed HOME and no global or system config.
  for (const name of SANDBOX_VARS) originalEnv[name] = process.env[name]
  const home = path.join(tmpDir, "home")
  fs.mkdirSync(home)
  process.env.HOME = home
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"
  process.env.GIT_CONFIG_SYSTEM = "/dev/null"
  delete process.env.GIT_SSH_COMMAND
  delete process.env.GIT_SSH

  // "Server": a small monorepo at acme/mono.git under the directory the fake
  // ssh serves from. It serves blobless clones, as GitHub and GitLab do, so a
  // sparse clone's checkout fetches file contents over ssh.
  const seed = path.join(tmpDir, "seed")
  fs.mkdirSync(path.join(seed, "modules", "vpc"), { recursive: true })
  fs.mkdirSync(path.join(seed, "modules", "eks"), { recursive: true })
  fs.writeFileSync(path.join(seed, "README.md"), "# mono\n")
  fs.writeFileSync(path.join(seed, "modules", "vpc", "main.tf"), "# vpc\n")
  fs.writeFileSync(path.join(seed, "modules", "eks", "main.tf"), "# eks\n")
  git(seed, "init", "-q", "-b", "main")
  git(seed, "add", ".")
  git(seed, "commit", "-q", "-m", "init")
  const serveRoot = path.join(tmpDir, "serve")
  const bare = path.join(serveRoot, "acme", "mono.git")
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  git(tmpDir, "clone", "-q", "--bare", seed, bare)
  git(bare, "config", "uploadpack.allowFilter", "true")

  const bin = path.join(tmpDir, "bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "ssh"), FAKE_SSH, { mode: 0o755 })
  sshLog = path.join(tmpDir, "ssh.log")
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`
  process.env.FAKE_SSH_LOG = sshLog
  process.env.FAKE_SSH_ROOT = serveRoot

  process.env.GIT_CONFIG_COUNT = "1"
  process.env.GIT_CONFIG_KEY_0 = "core.sshCommand"
  process.env.GIT_CONFIG_VALUE_0 = USER_SSH_COMMAND

  await runtime.runPromise(sessionManager.createSession(workDir))
  registerGitHandlers()
})

afterAll(() => {
  sessionManager.deleteSession()
  for (const name of SANDBOX_VARS) {
    if (originalEnv[name] === undefined) delete process.env[name]
    else process.env[name] = originalEnv[name]
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const event = { sender: { send: () => {} } }
const clone = (params: Record<string, unknown>) => handlers.get("git:clone")!(event, params)

describe("git:clone over ssh", () => {
  it("runs every step of a sparse repo_path clone through the user's core.sshCommand in batch mode", async () => {
    fs.rmSync(sshLog, { force: true })

    const result = await clone({
      url: "gitlab@gitlab.corp.net:acme/mono.git",
      localPath: "mono",
      repo_path: "modules/vpc",
    })

    expect(result).toMatchObject({ status: "success", outputs: { repo_owner: "acme", repo_name: "mono" } })
    const dest = path.join(workDir, "mono")
    expect(fs.readFileSync(path.join(dest, "modules", "vpc", "main.tf"), "utf8")).toBe("# vpc\n")
    expect(fs.existsSync(path.join(dest, "modules", "eks"))).toBe(false)

    // The clone itself, then at least one more: the blobless clone's
    // checkout fetches the files it writes. Each ssh run, whichever step
    // started it, is the user's command with the no-prompt options.
    const runs = fs.readFileSync(sshLog, "utf8").trim().split("\n")
    expect(runs.length).toBeGreaterThanOrEqual(2)
    for (const run of runs) {
      expect(run).toContain(BATCH_SSH_ARGS)
      expect(run).toContain("gitlab@gitlab.corp.net")
    }
  })
})
