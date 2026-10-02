import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mockElectron } from "../test-utils/mock-electron.ts"

// git.ts registers its handlers on electron's ipcMain. Capture them so the
// real git:clone / git:clone-cancel handlers can be called directly; the rest
// of the stack (Effect runtime, session, process spawning) is the live one.
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

let tmpDir = ""
let pidFile = ""
// The stand-in git's pid, so a failed run never leaves it behind.
let gitPid: number | null = null
const originalPath = process.env.PATH

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-clone-cancel-"))
  pidFile = path.join(tmpDir, "git.pid")

  // A stand-in `git` that never finishes on its own, like a clone of a large
  // repository over a slow link, or one that has written the checkout but not
  // exited yet. It writes into the destination (its last argument), which a
  // cancelled git is not trusted to remove. `exec` keeps its pid, which it
  // records so the test can check whether the process is still alive. Only
  // the clone behaves so: any other git command the handler runs before it
  // (the core.sshCommand lookup) exits 1 at once, as git does for an unset
  // key, rather than hang or write into the test's working directory.
  const binDir = path.join(tmpDir, "bin")
  fs.mkdirSync(binDir)
  fs.writeFileSync(
    path.join(binDir, "git"),
    [
      "#!/bin/sh",
      '[ "$1" = clone ] || exit 1',
      `echo $$ > "${pidFile}"`,
      "for dest; do :; done",
      'mkdir -p "$dest" && echo partial > "$dest/partial"',
      `echo "Cloning into 'infra'..." >&2`,
      "exec sleep 30",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`

  await runtime.runPromise(sessionManager.createSession(path.join(tmpDir, "work")))
  registerGitHandlers()
})

afterAll(() => {
  if (gitPid !== null && isAlive(gitPid)) process.kill(gitPid, "SIGKILL")
  process.env.PATH = originalPath
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
}

describe("git:clone-cancel", () => {
  it.skipIf(process.platform === "win32")(
    "kills git, removes what it wrote, and replies only once both are done",
    async () => {
      const progress: unknown[] = []
      const event = {
        sender: {
          send: (channel: string, payload: unknown) => {
            if (channel === "git:clone-progress") progress.push(payload)
          },
        },
      }

      const clone = handlers.get("git:clone")!(event, {
        // Not a github.com/gitlab.com host, so no session token is looked up.
        url: "https://git.example.com/acme/infra.git",
        localPath: "infra",
        cloneId: "clone-1",
      })

      // git has started once its first progress line streams back.
      await waitFor(() => progress.length > 0)
      expect(progress[0]).toMatchObject({ line: "Cloning into 'infra'...", cloneId: "clone-1" })
      const pid = Number(fs.readFileSync(pidFile, "utf-8").trim())
      gitPid = pid
      expect(isAlive(pid)).toBe(true)
      const dest = path.join(tmpDir, "work", "infra")
      expect(fs.existsSync(path.join(dest, "partial"))).toBe(true)

      await expect(
        handlers.get("git:clone-cancel")!(null, { cloneId: "clone-1" }),
      ).resolves.toEqual({
        ok: true,
      })

      // By the reply, git is gone rather than still writing, and so is the
      // directory it made: the renderer offers Clone and Delete & Clone again
      // as soon as the reply lands.
      expect(isAlive(pid)).toBe(false)
      expect(fs.existsSync(dest)).toBe(false)
      // The user asked for this, so it is not reported as a failure.
      await expect(clone).resolves.toEqual({ status: "cancelled" })
    },
    15_000,
  )

  it("is a no-op for a clone that is not running", async () => {
    await expect(handlers.get("git:clone-cancel")!(null, { cloneId: "unknown" })).resolves.toEqual({
      ok: true,
    })
  })
})
