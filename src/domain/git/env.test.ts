import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { gitSpawnEnv, resolveSshCommand } from "./env.ts"
import { resolveRef } from "../../remote-source.ts"
import { ChildProcessSpawnerLive } from "../../layers/ChildProcessSpawner.ts"

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
      [
        "C:\\Program Files\\PuTTY\\PLINK.EXE",
        `'C:\\Program Files\\PuTTY\\PLINK.EXE' -batch`,
      ],
    ])("runs a plink GIT_SSH (%s) with -batch, since git only adds it for TortoisePlink", (gitSsh, expected) => {
      // GIT_SSH is a bare program run without a shell, so the path is quoted
      // to stay one word — git still reads plink from its basename.
      process.env.GIT_SSH = gitSsh
      expect(gitSpawnEnv().GIT_SSH_COMMAND).toBe(expected)
    })

    it("quotes a GIT_SSH path containing a single quote", () => {
      process.env.GIT_SSH = "/opt/o'brien/ssh"
      expect(gitSpawnEnv().GIT_SSH_COMMAND).toBe(`'/opt/o'\\''brien/ssh' ${BATCH_OPTIONS}`)
    })

    it.each(["C:\\Program Files\\TortoiseGit\\bin\\TortoisePlink.exe", "/usr/local/bin/my-ssh-wrapper"])(
      "leaves any other GIT_SSH (%s) for git to run as-is",
      (gitSsh) => {
        process.env.GIT_SSH = gitSsh
        const env = gitSpawnEnv()
        expect(env.GIT_SSH_COMMAND).toBeUndefined()
        expect(env.GIT_SSH).toBe(gitSsh)
      },
    )

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

describe("resolveSshCommand (real git)", () => {
  // Only the config each test writes decides the answer.
  isolateEnv(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"])
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

describe("remote-source resolveRef ssh command (real git)", () => {
  isolateEnv(["GIT_SSH_COMMAND", "GIT_SSH", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"])
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
        Effect.either,
      ),
    )

    const args = fs.readFileSync(fakeSsh.log, "utf8")
    expect(args).toContain(`-i /keys/id_work ${BATCH_OPTIONS}`)
    expect(args).toContain("git-upload-pack")
  })
})
