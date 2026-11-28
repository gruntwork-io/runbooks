/**
 * Session env through the real IPC handlers: runbook:get creating the session
 * and exec:run applying what a script wrote to RUNBOOK_ENV, with real bash
 * scripts.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { mockElectron } from "../test-utils/mock-electron.ts"

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
const { installTestSessionPersistence } = await import("../test-utils/session-persistence.ts")
type TestSessionPersistence = ReturnType<typeof installTestSessionPersistence>

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
    await new Promise((r) => {
      setTimeout(r, 50)
    })
  }
  return pred()
}

let tmpDir = ""
let sessions: TestSessionPersistence
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
  sessions = installTestSessionPersistence()
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
  sessions.cleanup()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("runbook:get session env", () => {
  it("starts from the app's environment, AWS credentials included, in a runbook with <AwsAuth>", async () => {
    const ctx = await openRunbook(
      writeRunbook(
        "with-aws-auth",
        '# Deploy\n\n<AwsAuth id="aws-auth" />\n\n<Command id="deploy" command="aws sts get-caller-identity" />\n',
      ),
    )

    expect(awsKeysOf(ctx.env)).toEqual(AWS_ENV)
  })
})

describe("exec:run session env", () => {
  /**
   * Open a runbook whose one Command signals that it started, blocks until
   * released, then sets FROM_SCRIPT for the session. Returns a way to start it
   * and a way to let it finish.
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
        'echo FROM_SCRIPT=1 >> "$RUNBOOK_ENV"',
        "",
      ].join("\n"),
    })
    await openRunbook(dir)
    const { executables } = (await handlers.get("runbook:executables")!({})) as {
      executables: Record<string, { componentId: string }>
    }
    const executableId = Object.keys(executables).find(
      (id) => executables[id]!.componentId === "wait",
    )!

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

  it("keeps what another script and a sign-in set while the script ran", async () => {
    const runbook = await openBlockingRunbook("mid-run-auth")

    const run = await runbook.start()
    // Another script finishes, and an auth block signs in, while this one runs.
    const generation = sessionManager.getGeneration()
    await runtime.runPromise(sessionManager.applyScriptEnv({ env: { OTHER: "1" }, generation }))
    const gh = { env: { GITHUB_TOKEN: "ghp_mid_run" }, clears: [] }
    await runtime.runPromise(sessionManager.setEnvExport("gh", gh, generation))
    runbook.release()

    expect((await run.finished).status?.status).toBe("success")
    const ctx = await runtime.runPromise(sessionManager.getExecContext())
    expect(ctx.env).toMatchObject({ FROM_SCRIPT: "1", OTHER: "1" })
    expect(ctx.env.GITHUB_TOKEN).toBeUndefined()
    expect(sessionManager.getEnvExport("gh")).toEqual(gh)
  }, 30000)

  it("keeps what a script exports and where it cd's to inside the script", async () => {
    const ctx = await runCommand("exported", `export LEAKED=1; cd '${tmpDir}'`)

    expect(ctx.env.LEAKED).toBeUndefined()
    expect(ctx.workDir).toBe(
      nodePath.join(sessions.dirsRoot, sessions.persistence.currentSession()!.id),
    )
  }, 30000)

  it("runs a block in its workingDir, inside the session's directory", async () => {
    const out = nodePath.join(tmpDir, "working-dir.out")
    await openRunbook(
      writeRunbook(
        "working-dir",
        `<Command id="cmd" workingDir="infra/live" command="pwd > '${out}'" />\n`,
      ),
    )
    const sessionDir = nodePath.join(sessions.dirsRoot, sessions.persistence.currentSession()!.id)
    fs.mkdirSync(nodePath.join(sessionDir, "infra", "live"), { recursive: true })
    const { executables } = (await handlers.get("runbook:executables")!({})) as {
      executables: Record<string, { componentId: string }>
    }
    const executableId = Object.keys(executables).find(
      (id) => executables[id]!.componentId === "cmd",
    )!

    const result = (await handlers.get("exec:run")!(
      { sender: { send: () => {} } },
      { executableId, executionId: "working-dir" },
    )) as { status: { status: string } | null }

    expect(result.status?.status).toBe("success")
    expect(fs.realpathSync(fs.readFileSync(out, "utf8").trim())).toBe(
      fs.realpathSync(nodePath.join(sessionDir, "infra", "live")),
    )
  }, 30000)

  /** Open a runbook with one inline Command and run it to completion. */
  async function runCommand(name: string, command: string) {
    await openRunbook(writeRunbook(name, `<Command id="cmd" command="${command}" />\n`))
    const { executables } = (await handlers.get("runbook:executables")!({})) as {
      executables: Record<string, { componentId: string }>
    }
    const executableId = Object.keys(executables).find(
      (id) => executables[id]!.componentId === "cmd",
    )!
    const result = (await handlers.get("exec:run")!(
      { sender: { send: () => {} } },
      { executableId, executionId: name },
    )) as { status: { status: string } | null }
    expect(result.status?.status).toBe("success")
    return runtime.runPromise(sessionManager.getExecContext())
  }

  /** Open a runbook with an <AwsAuth> block and a Command that names it in envFrom. */
  async function openEnvFromRunbook(name: string, out: string) {
    await openRunbook(
      writeRunbook(
        name,
        `<AwsAuth id="aws" />\n\n<Command id="cmd" envFrom={["aws"]} command="printenv AWS_ACCESS_KEY_ID AWS_SESSION_TOKEN > '${out}' || true" />\n`,
      ),
    )
    const { executables } = (await handlers.get("runbook:executables")!({})) as {
      executables: Record<string, { componentId: string }>
    }
    const executableId = Object.keys(executables).find(
      (id) => executables[id]!.componentId === "cmd",
    )!
    return () =>
      handlers.get("exec:run")!(
        { sender: { send: () => {} } },
        { executableId, executionId: name },
      ) as Promise<{ status: { status: string } | null }>
  }

  it("runs a block with the sign-in its envFrom names, and keeps it out of the session", async () => {
    const out = nodePath.join(tmpDir, "env-from.out")
    const run = await openEnvFromRunbook("env-from", out)
    await runtime.runPromise(
      sessionManager.setEnvExport(
        "aws",
        { env: { AWS_ACCESS_KEY_ID: "AKIA_BLOCK" }, clears: ["AWS_SESSION_TOKEN"] },
        sessionManager.getGeneration(),
      ),
    )

    expect((await run()).status?.status).toBe("success")
    // The block's key, and no session token from the app's environment
    expect(fs.readFileSync(out, "utf8")).toBe("AKIA_BLOCK\n")
    const ctx = await runtime.runPromise(sessionManager.getExecContext())
    expect(awsKeysOf(ctx.env)).toEqual(AWS_ENV)
  }, 30000)

  it("fails a block whose envFrom names a block that isn't signed in, running nothing", async () => {
    const out = nodePath.join(tmpDir, "env-from-missing.out")
    const run = await openEnvFromRunbook("env-from-missing", out)

    await expect(run()).rejects.toThrow("aws isn't signed in")
    expect(fs.existsSync(out)).toBe(false)
  }, 30000)

  it("gives a script its block's env as data, and keeps the variables out of the session", async () => {
    const marker = nodePath.join(tmpDir, "env-prop.pwned")
    const out = nodePath.join(tmpDir, "env-prop.out")
    // What an output taken from a PR title could hold: shell code that would
    // run if the script's source were built from it.
    const title = `Fix typo $(touch '${marker}') \`touch '${marker}'\` "; touch '${marker}'; echo "`
    const env = `{{ PR_TITLE: ${JSON.stringify(title)}, STAGE: "dev" }}`
    const script = `printf '%s' "$PR_TITLE" > '${out}'; echo STAGE=prod >> "$RUNBOOK_ENV"`
    await openRunbook(
      writeRunbook(
        "env-prop",
        `<Command id="cmd" env=${env} command={${JSON.stringify(script)}} />\n`,
      ),
    )
    const { executables } = (await handlers.get("runbook:executables")!({})) as {
      executables: Record<string, { componentId: string }>
    }
    const executableId = Object.keys(executables).find(
      (id) => executables[id]!.componentId === "cmd",
    )!

    const result = (await handlers.get("exec:run")!(
      { sender: { send: () => {} } },
      { executableId, executionId: "env-prop" },
    )) as { status: { status: string } | null }

    expect(result.status?.status).toBe("success")
    expect(fs.readFileSync(out, "utf8")).toBe(title)
    expect(fs.existsSync(marker)).toBe(false)
    const ctx = await runtime.runPromise(sessionManager.getExecContext())
    expect(ctx.env.PR_TITLE).toBeUndefined()
    // A variable the script writes to RUNBOOK_ENV is the script's.
    expect(ctx.env.STAGE).toBe("prod")
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
  }, 30000)
})
