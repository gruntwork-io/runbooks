/**
 * Session env through the real IPC handlers: runbook:get creating the session
 * and exec:run applying a script's captured env, with real bash scripts.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { mockElectron } from "../test-utils/mockElectron.ts"

// Capture what the handlers register on electron's ipcMain so they run for
// real, without an Electron runtime.
type Handler = (event: unknown, params?: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
mockElectron({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  },
})

const { registerRunbookHandlers } = await import("./runbook.ts")
const { registerExecHandlers } = await import("./exec.ts")
const { runtime, sessionManager } = await import("./runtime.ts")

const AWS_ENV = {
  AWS_ACCESS_KEY_ID: "AKIATERMINAL",
  AWS_SECRET_ACCESS_KEY: "terminal-secret",
  AWS_SESSION_TOKEN: "terminal-session",
}

/** Just the AWS keys of a session env (a failure then never prints the rest). */
function awsKeysOf(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key in AWS_ENV))
}

/** Poll `pred` until it's true or the deadline passes. */
async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return pred()
}

let tmpDir = ""
const savedEnv: Record<string, string | undefined> = {}

/** Write `<name>/runbook.mdx` (plus any extra files) and return its directory. */
function writeRunbook(name: string, content: string, files: Record<string, string> = {}): string {
  const dir = nodePath.join(tmpDir, name)
  fs.mkdirSync(dir)
  fs.writeFileSync(nodePath.join(dir, "runbook.mdx"), content)
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(nodePath.dirname(nodePath.join(dir, rel)), { recursive: true })
    fs.writeFileSync(nodePath.join(dir, rel), body)
  }
  return dir
}

async function openRunbook(dir: string) {
  await handlers.get("runbook:get")!({}, { path: dir })
  return runtime.runPromise(sessionManager.getExecContext())
}

beforeAll(() => {
  registerRunbookHandlers()
  registerExecHandlers()
  tmpDir = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-session-env-")))
  // The app's session env comes from process.env (the terminal's, or the
  // login shell's that shell-env loads) — put AWS keys there.
  for (const [key, value] of Object.entries(AWS_ENV)) {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  sessionManager.deleteSession()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("runbook:get session env", () => {
  it("strips inherited AWS credentials for a runbook with <AwsAuth>, and only for it", async () => {
    const withAwsAuth = writeRunbook(
      "with-aws-auth",
      '# Deploy\n\n<AwsAuth id="aws-auth" />\n\n<Command id="deploy" command="aws sts get-caller-identity" />\n',
    )
    const withoutAwsAuth = writeRunbook(
      "without-aws-auth",
      '# Hello\n\n<Command id="hello" command="aws sts get-caller-identity" />\n',
    )

    const protectedCtx = await openRunbook(withAwsAuth)
    expect(Object.keys(awsKeysOf(protectedCtx.env))).toEqual([])

    // Opening a runbook without <AwsAuth> next must not inherit the stripping.
    const plainCtx = await openRunbook(withoutAwsAuth)
    expect(awsKeysOf(plainCtx.env)).toEqual(AWS_ENV)
  })
})

describe("exec:run captured env", () => {
  /**
   * Open a runbook whose one Command signals that it started, blocks until
   * released, then exports FROM_SCRIPT and cd's out of the runbook directory.
   * Returns a way to start it and a way to let it finish.
   */
  async function openBlockingRunbook(name: string) {
    const started = nodePath.join(tmpDir, `${name}.started`)
    const release = nodePath.join(tmpDir, `${name}.release`)
    const dir = writeRunbook(name, '<Command id="wait" path="scripts/wait.sh" />\n', {
      "scripts/wait.sh": [
        "#!/bin/bash",
        `touch '${started}'`,
        // Bounded, so a failed test can't leave the loop running (~30s).
        `for _ in $(seq 600); do [ -f '${release}' ] && break; sleep 0.05; done`,
        "export FROM_SCRIPT=1",
        `cd '${tmpDir}'`,
        "",
      ].join("\n"),
    })
    await openRunbook(dir)
    const { executables } = (await handlers.get("runbook:executables")!({})) as {
      executables: Record<string, { componentId: string }>
    }
    const executableId = Object.keys(executables).find((id) => executables[id]!.componentId === "wait")!

    return {
      /**
       * Start the script and resolve once it's running (so its env snapshot
       * has been taken), with `finished` settling when exec:run returns.
       */
      async start() {
        const sender = { send: () => {} }
        const finished = handlers.get("exec:run")!(
          { sender },
          { executableId, executionId: name },
        ) as Promise<{ status: { status: string } | null }>
        expect(await waitUntil(() => fs.existsSync(started), 15000)).toBe(true)
        return { finished }
      },
      release: () => fs.writeFileSync(release, ""),
    }
  }

  it("keeps session env an auth block wrote while the script ran", async () => {
    const runbook = await openBlockingRunbook("mid-run-auth")
    await runtime.runPromise(sessionManager.appendToEnv({ PRE_EXISTING: "stale" }))

    const run = await runbook.start()
    // What GitAuth / AwsAuth / GoogleAuth do while a long Command is running.
    await runtime.runPromise(sessionManager.appendToEnv({ GITHUB_TOKEN: "ghp_mid_run", PRE_EXISTING: "fresh" }))
    await runtime.runPromise(sessionManager.removeFromEnv(["AWS_SESSION_TOKEN"]))
    runbook.release()

    expect((await run.finished).status?.status).toBe("success")
    const ctx = await runtime.runPromise(sessionManager.getExecContext())
    expect(ctx.env.FROM_SCRIPT).toBe("1")
    expect(ctx.env.GITHUB_TOKEN).toBe("ghp_mid_run")
    expect(ctx.env.PRE_EXISTING).toBe("fresh")
    expect(ctx.env.AWS_SESSION_TOKEN).toBeUndefined()
    expect(ctx.workDir).toBe(tmpDir)
  }, 30000)

  it("does not apply a script's env to a runbook opened while it ran", async () => {
    const runbook = await openBlockingRunbook("switched-away")
    const run = await runbook.start()

    // The user opens another runbook before the first one's script finishes.
    const other = writeRunbook("opened-mid-run", "# Other\n")
    await openRunbook(other)
    runbook.release()
    await run.finished

    const ctx = await runtime.runPromise(sessionManager.getExecContext())
    expect(ctx.env.FROM_SCRIPT).toBeUndefined()
    expect(ctx.workDir).toBe(other)
  }, 30000)
})
