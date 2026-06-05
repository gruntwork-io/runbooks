import { describe, it, expect } from "bun:test"
import { gitSpawnEnv } from "./env.ts"

describe("gitSpawnEnv", () => {
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
})
