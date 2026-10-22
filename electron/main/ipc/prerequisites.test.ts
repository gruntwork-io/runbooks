/**
 * A <Prerequisites> block through the real IPC handlers: runbook:get
 * registering its tool list and exec:run checking it, with real bash. A fake
 * login shell stands in for the user's, adding a directory to PATH the way an
 * installer's line in an rc file does.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect } from "effect"
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

interface RunResult {
  status: { status: string; exitCode: number } | null
  outputs?: Record<string, { value: string; sensitive: boolean }>
}

let tmpDir = ""
let lateBinDir = ""
let sessions: TestSessionPersistence
const savedEnv = { PATH: process.env.PATH, SHELL: process.env.SHELL }

beforeAll(() => {
  registerRunbookHandlers()
  registerExecHandlers()
  sessions = installTestSessionPersistence()
  tmpDir = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-prereqs-ipc-")))
  lateBinDir = nodePath.join(tmpDir, "late-bin")
  fs.mkdirSync(lateBinDir)
  fs.writeFileSync(nodePath.join(lateBinDir, "late-tool"), "#!/bin/sh\necho late-tool 2.1.0\n", {
    mode: 0o755,
  })

  // Stand-in for the user's $SHELL: an rc file that puts late-bin on PATH,
  // then the capture script ("$2", after -ilc).
  const fakeShell = nodePath.join(tmpDir, "fake-shell")
  fs.writeFileSync(
    fakeShell,
    ["#!/bin/sh", `export PATH="${lateBinDir}:$PATH"`, 'exec /bin/sh -c "$2"', ""].join("\n"),
    { mode: 0o755 },
  )
  process.env.SHELL = fakeShell
})

afterEach(() => {
  // A check that read PATH again added late-bin to the app's PATH.
  process.env.PATH = savedEnv.PATH
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

/** Write `<name>/runbook.mdx` with a <Prerequisites> block listing `toolsYaml`, and open it. */
async function openRunbook(name: string, toolsYaml: string): Promise<void> {
  const dir = nodePath.join(tmpDir, name)
  fs.mkdirSync(dir)
  fs.writeFileSync(
    nodePath.join(dir, "runbook.mdx"),
    `# ${name}\n\n<Prerequisites id="tools">\n\`\`\`yaml\n${toolsYaml}\`\`\`\n</Prerequisites>\n`,
  )
  await handlers.get("runbook:get")!({}, { path: dir })
}

/** Run the open runbook's <Prerequisites> block, returning its result and the log lines it sent. */
async function check(executionId: string): Promise<{ result: RunResult; lines: string[] }> {
  const { executables } = (await handlers.get("runbook:executables")!({})) as {
    executables: Record<string, { componentId: string; componentType: string }>
  }
  const [executableId, executable] = Object.entries(executables).find(
    ([, entry]) => entry.componentId === "tools",
  )!
  expect(executable.componentType).toBe("prerequisites")

  const lines: string[] = []
  const sender = {
    send: (channel: string, payload: { line?: string }) => {
      if (channel === "exec:log" && payload.line) lines.push(payload.line)
    },
  }
  const result = (await handlers.get("exec:run")!(
    { sender },
    { executableId, executionId },
  )) as RunResult
  return { result, lines }
}

/** The env changes the open session has saved. */
function savedEnvChanges(): { set: Record<string, string>; unset: string[] } {
  const id = sessions.persistence.currentSession()!.id
  const record = Effect.runSync(sessions.store.get(id))!
  return JSON.parse(new TextDecoder().decode(record.env))
}

describe("exec:run for a <Prerequisites> block", () => {
  it("checks the tools it lists and returns their outputs, though the check failed", async () => {
    await openRunbook("missing-tool", "tools:\n  - bash\n  - no-such-tool-x9\n")

    const { result, lines } = await check("missing-tool")

    expect(result.status).toEqual({ status: "fail", exitCode: 1 })
    expect(result.outputs?.bash_path?.value).toMatch(/\/bash$/)
    expect(result.outputs?.no_such_tool_x9_path).toEqual({ value: "", sensitive: false })
    expect(lines.at(-1)).toContain("Tools to install or update: no-such-tool-x9.")
  }, 30000)

  it("reads PATH again from the login shell for a missing tool, and keeps what it adds", async () => {
    await openRunbook("late-tool", 'tools:\n  - name: late-tool\n    version: ">= 2"\n')

    const { result, lines } = await check("late-tool")

    expect(result.status).toEqual({ status: "success", exitCode: 0 })
    expect(result.outputs).toEqual({
      late_tool_path: { value: nodePath.join(lateBinDir, "late-tool"), sensitive: false },
      late_tool_version: { value: "2.1.0", sensitive: false },
    })
    expect(lines[0]).toContain(
      `late-tool wasn't on PATH, so Runbooks read PATH again from your login shell (${process.env.SHELL}) and added ${lateBinDir}.`,
    )

    // On the end of PATH: the session's, for the blocks that run next, and
    // the app's, for sessions opened later.
    const ctx = await runtime.runPromise(sessionManager.getExecContext())
    expect(ctx.env.PATH?.endsWith(`:${lateBinDir}`)).toBe(true)
    expect(process.env.PATH?.endsWith(`:${lateBinDir}`)).toBe(true)
    // ...and not a change the session saves, which would pin this PATH when
    // it's resumed.
    expect(savedEnvChanges()).toEqual({ set: {}, unset: [] })
  }, 30000)
})
