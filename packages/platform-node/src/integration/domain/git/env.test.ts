import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { gitSpawnEnv, resolveSshCommand } from "@runbooks/core/domain/git/env"
import { resolveRef } from "@runbooks/core/remote-source"
import { ChildProcessSpawnerLive } from "../../../layers/ChildProcessSpawner.ts"
import { makeControlledSpawner } from "@runbooks/core/test-utils/TestSpawner"

const BATCH_OPTIONS = "-o BatchMode=yes -o StrictHostKeyChecking=yes"

/**
 * Clear `keys` from process.env for each test and put the originals back
 * after, so neither the developer's shell nor another test decides the result.
 */
function isolateEnv(keys: string[]): void {
  const saved = new Map<string, string | undefined>()
  beforeEach(() => {
    for (const key of keys) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
  })
  afterEach(() => {
    for (const key of keys) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

/**
 * Variables that point git at a repository other than the one in its cwd. A
 * git hook exports some of them, so a test run started from one would write
 * its config into the developer's repository instead of its temp directory.
 */
const GIT_REPO_LOCATION_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
]

/**
 * A stand-in ssh that appends its arguments to `log` and fails the way an
 * unreachable host would. Named `ssh` so git treats it as OpenSSH.
 */
function writeFakeSsh(dir: string): { command: string; log: string } {
  const log = path.join(dir, "ssh-args.log")
  const command = path.join(dir, "ssh")
  fs.writeFileSync(command, `#!/bin/sh\necho "$*" >> '${log}'\nexit 255\n`, { mode: 0o755 })
  return { command, log }
}

describe("gitSpawnEnv", () => {
  isolateEnv(["GIT_SSH_COMMAND", "GIT_SSH"])

  it("forces ssh into batch mode with strict host-key checking", () => {
    // BatchMode=yes makes ssh fail instead of prompting (passphrase/password),
    // and StrictHostKeyChecking=yes makes an unknown host fail fast rather than
    // hanging on the "Are you sure you want to continue connecting?" prompt.
    const env = gitSpawnEnv()
    expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes")
    expect(env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes")
  })

  it("disables git's own interactive credential prompt", () => {
    expect(gitSpawnEnv().GIT_TERMINAL_PROMPT).toBe("0")
  })

  it("preserves the inherited environment so git/ssh still find PATH, HOME, and the ssh-agent", () => {
    // spawn() replaces the inherited env wholesale when given an explicit one,
    // so dropping these would break git and ssh entirely.
    process.env.SSH_AUTH_SOCK = "/tmp/agent.test.sock"
    const env = gitSpawnEnv()
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.HOME).toBe(process.env.HOME)
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/agent.test.sock")
    delete process.env.SSH_AUTH_SOCK
  })

  it("overrides any inherited values that would re-enable prompting", () => {
    process.env.GIT_TERMINAL_PROMPT = "1"
    expect(gitSpawnEnv().GIT_TERMINAL_PROMPT).toBe("0")
    delete process.env.GIT_TERMINAL_PROMPT
  })

  describe("wraps the ssh client the user's git would run", () => {
    it("runs plain ssh when nothing else is configured", () => {
      expect(gitSpawnEnv().GIT_SSH_COMMAND).toBe(`ssh ${BATCH_OPTIONS}`)
    })

    it("keeps an inherited GIT_SSH_COMMAND and appends the batch flags", () => {
      // The user's own flags come first, and ssh keeps the first value it sees
      // for an option, so anything they set explicitly still wins.
      process.env.GIT_SSH_COMMAND = "ssh -i /keys/id_work"
      expect(gitSpawnEnv().GIT_SSH_COMMAND).toBe(`ssh -i /keys/id_work ${BATCH_OPTIONS}`)
    })

    it("wraps the core.sshCommand it is given", () => {
      expect(gitSpawnEnv("ssh -i /keys/id_work").GIT_SSH_COMMAND).toBe(
        `ssh -i /keys/id_work ${BATCH_OPTIONS}`,
      )
    })

    it("ranks an inherited GIT_SSH_COMMAND over core.sshCommand, as git does", () => {
      process.env.GIT_SSH_COMMAND = "ssh -i /keys/from-env"
      expect(gitSpawnEnv("ssh -i /keys/from-config").GIT_SSH_COMMAND).toBe(
        `ssh -i /keys/from-env ${BATCH_OPTIONS}`,
      )
    })

    it("ranks core.sshCommand over GIT_SSH, as git does", () => {
      process.env.GIT_SSH = "/opt/putty/plink"
      expect(gitSpawnEnv("ssh -i /keys/id_work").GIT_SSH_COMMAND).toBe(
        `ssh -i /keys/id_work ${BATCH_OPTIONS}`,
      )
    })

    it.each([
      ["/opt/putty/plink", `'/opt/putty/plink' -batch`],
      ["C:\\Program Files\\PuTTY\\PLINK.EXE", `'C:\\Program Files\\PuTTY\\PLINK.EXE' -batch`],
    ])(
      "runs a plink GIT_SSH (%s) with -batch, since git only adds it for TortoisePlink",
      (gitSsh, expected) => {
        // GIT_SSH is a bare program run without a shell, so the path is quoted
        // to stay one word — git still reads plink from its basename.
        process.env.GIT_SSH = gitSsh
        expect(gitSpawnEnv().GIT_SSH_COMMAND).toBe(expected)
      },
    )

    it("quotes a GIT_SSH path containing a single quote", () => {
      process.env.GIT_SSH = "/opt/o'brien/ssh"
      expect(gitSpawnEnv().GIT_SSH_COMMAND).toBe(`'/opt/o'\\''brien/ssh' ${BATCH_OPTIONS}`)
    })

    it.each([
      "C:\\Program Files\\TortoiseGit\\bin\\TortoisePlink.exe",
      "/usr/local/bin/my-ssh-wrapper",
    ])("leaves any other GIT_SSH (%s) for git to run as-is", (gitSsh) => {
      process.env.GIT_SSH = gitSsh
      const env = gitSpawnEnv()
      expect(env.GIT_SSH_COMMAND).toBeUndefined()
      expect(env.GIT_SSH).toBe(gitSsh)
    })

    it("gives a plink command -batch rather than ssh options it would reject", () => {
      const command = `"C:\\Program Files\\PuTTY\\plink.exe" -ssh`
      expect(gitSpawnEnv(command).GIT_SSH_COMMAND).toBe(`${command} -batch`)
    })

    it("adds nothing to a TortoisePlink command, which git runs with -batch itself", () => {
      process.env.GIT_SSH_COMMAND = "TortoisePlink.exe"
      expect(gitSpawnEnv().GIT_SSH_COMMAND).toBe("TortoisePlink.exe")
    })
  })
})

/** The `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` pairs in `env`, in order. */
function gitConfigEntries(env: Record<string, string | undefined>): Array<[string, string]> {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10)
  return Array.from({ length: count }, (_, i) => [
    env[`GIT_CONFIG_KEY_${i}`] ?? "",
    env[`GIT_CONFIG_VALUE_${i}`] ?? "",
  ])
}

describe("gitSpawnEnv repository config", () => {
  isolateEnv(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"])

  it("turns off the settings that let a repository's own config run a command", () => {
    expect(gitConfigEntries(gitSpawnEnv())).toEqual([
      ["core.fsmonitor", "false"],
      ["safe.bareRepository", "explicit"],
    ])
  })

  it("adds them after config the environment already passes, so they win over it", () => {
    process.env.GIT_CONFIG_COUNT = "1"
    process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor"
    process.env.GIT_CONFIG_VALUE_0 = "/tmp/hook"
    expect(gitConfigEntries(gitSpawnEnv())).toEqual([
      ["core.fsmonitor", "/tmp/hook"],
      ["core.fsmonitor", "false"],
      ["safe.bareRepository", "explicit"],
    ])
  })
})

describe("gitSpawnEnv repository config (real git)", () => {
  // Only the config each test writes, and gitSpawnEnv's, decides the result.
  isolateEnv([
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    ...GIT_REPO_LOCATION_ENV,
  ])
  let tmp: string

  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    process.env.GIT_CONFIG_SYSTEM = "/dev/null"
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-repo-config-"))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  /** Run git in `cwd`, as itself (`env` undefined) or as Runbooks spawns it. */
  const git = (cwd: string, args: string[], env?: Record<string, string | undefined>) =>
    execFileSync("git", args, { cwd, env: env ?? process.env, stdio: "pipe" }).toString()

  it("does not run the command a repository's core.fsmonitor names", () => {
    // What a <GitClone> block's local checkout can be: a directory someone
    // else prepared. git runs core.fsmonitor from the work tree's root, so
    // the command leaves its mark there.
    git(tmp, ["init", "-q"])
    git(tmp, ["config", "core.fsmonitor", "echo ran > fsmonitor-ran; false"])
    const ran = () => fs.existsSync(path.join(tmp, "fsmonitor-ran"))

    git(tmp, ["status", "--porcelain"], gitSpawnEnv())
    git(tmp, ["ls-files"], gitSpawnEnv())
    expect(ran()).toBe(false)

    // The same repository does run it for a git without gitSpawnEnv's config,
    // so the check above can't pass for want of a working command.
    git(tmp, ["status", "--porcelain"])
    expect(ran()).toBe(true)
  })

  it("does not take a plain directory of repository files for a repository", () => {
    // A clone can carry these as committed files, config included, where a
    // `.git` directory can't be committed. Without safe.bareRepository git
    // opens the directory as a repository and reads that config.
    const embedded = path.join(tmp, "embedded")
    git(tmp, ["init", "-q", "--bare", embedded])
    fs.mkdirSync(path.join(embedded, "wt"))
    git(embedded, ["config", "core.bare", "false"])
    git(embedded, ["config", "core.worktree", "wt"])

    expect(git(embedded, ["rev-parse", "--show-toplevel"]).trim()).toContain("wt")
    expect(() => git(embedded, ["rev-parse", "--show-toplevel"], gitSpawnEnv())).toThrow(
      /safe\.bareRepository/,
    )
  })

  it("still opens a checkout and a linked worktree of it", () => {
    const repo = path.join(tmp, "repo")
    const linked = path.join(tmp, "linked")
    git(tmp, ["init", "-q", repo])
    git(repo, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ])
    git(repo, ["worktree", "add", "-q", linked])

    const toplevel = (cwd: string) =>
      fs.realpathSync(git(cwd, ["rev-parse", "--show-toplevel"], gitSpawnEnv()).trim())
    expect(toplevel(repo)).toBe(fs.realpathSync(repo))
    expect(toplevel(linked)).toBe(fs.realpathSync(linked))
  })
})

describe("resolveSshCommand (real git)", () => {
  // Only the config each test writes decides the answer.
  isolateEnv(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", ...GIT_REPO_LOCATION_ENV])
  let tmp: string

  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    process.env.GIT_CONFIG_SYSTEM = "/dev/null"
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-sshcommand-"))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const run = (cwd?: string) =>
    Effect.runPromise(resolveSshCommand(cwd).pipe(Effect.provide(ChildProcessSpawnerLive)))

  it("reads a repo-local core.sshCommand from the repo it is given", async () => {
    // The usual multi-account setup: a per-repo key, set inside the checkout.
    execFileSync("git", ["init", "-q", tmp])
    execFileSync("git", ["-C", tmp, "config", "core.sshCommand", "ssh -i /keys/id_work"])
    expect(await run(tmp)).toBe("ssh -i /keys/id_work")
  })

  it("is undefined when core.sshCommand is not set", async () => {
    expect(await run(tmp)).toBeUndefined()
  })

  it("is undefined when the directory does not exist", async () => {
    expect(await run(path.join(tmp, "missing"))).toBeUndefined()
  })
})

describe("resolveSshCommand timeout", () => {
  it("treats a git config that never answers as unset, and kills it", async () => {
    // Every clone and push waits on this lookup, so a git stuck reading its
    // config (say, a home directory on a stalled network share) must not hang them.
    const spawner = makeControlledSpawner()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const lookup = yield* Effect.forkChild(
          resolveSshCommand("/repo").pipe(Effect.provide(spawner.layer)),
        )
        // Let the lookup spawn git and register its timeout with the TestClock.
        yield* Effect.promise(
          () =>
            new Promise((resolve) => {
              setTimeout(resolve, 20)
            }),
        )
        expect(spawner.processes).toHaveLength(1)
        yield* TestClock.adjust("5 seconds")
        return yield* Fiber.join(lookup)
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result).toBeUndefined()
    expect(spawner.processes[0]!.killed()).toBe(true)
  })
})

describe("remote-source resolveRef ssh command (real git)", () => {
  isolateEnv([
    "GIT_SSH_COMMAND",
    "GIT_SSH",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
  ])
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-lsremote-"))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("runs ls-remote over the user's core.sshCommand, in batch mode", async () => {
    // resolveRef has no repo, so it reads config where git runs. Environment
    // config outranks every config file, including the one of the checkout
    // these tests run from.
    const fakeSsh = writeFakeSsh(tmp)
    process.env.GIT_CONFIG_COUNT = "1"
    process.env.GIT_CONFIG_KEY_0 = "core.sshCommand"
    process.env.GIT_CONFIG_VALUE_0 = `'${fakeSsh.command}' -i /keys/id_work`

    await Effect.runPromise(
      resolveRef("git@example.invalid:o/r.git", "main/docs").pipe(
        Effect.provide(ChildProcessSpawnerLive),
        Effect.result,
      ),
    )

    const args = fs.readFileSync(fakeSsh.log, "utf8")
    expect(args).toContain(`-i /keys/id_work ${BATCH_OPTIONS}`)
    expect(args).toContain("git-upload-pack")
    // Real git and ssh processes: like the other real-git tests, more than
    // bun's 5 s default, which a loaded full-suite run can exceed.
  }, 30_000)
})
