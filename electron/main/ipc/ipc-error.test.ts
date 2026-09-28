import { describe, it, expect, afterAll } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import {
  ExecutableNotFoundError,
  FileReadError,
  GitError,
  GitHubApiError,
  PathTraversalError,
  RenderError,
  SessionNotFoundError,
} from "../../../src/errors/index.ts"
import { cleanIpcErrorMessage } from "../../shared/ipc-error-message.ts"
import { describeFailure, installIpcErrorNormalization, toIpcError } from "./ipc-error.ts"

// A real ManagedRuntime, so failures reject with the same FiberFailure the
// handlers' `runtime.runPromise(...)` produces.
const runtime = ManagedRuntime.make(Layer.empty)
afterAll(() => runtime.dispose())

/** Run a program the way a handler does and return what it rejects with. */
async function rejectionOf(program: Effect.Effect<unknown, unknown>): Promise<unknown> {
  try {
    await runtime.runPromise(program)
  } catch (err) {
    return err
  }
  throw new Error("expected the program to fail")
}

const enoent = () => new Error("ENOENT: no such file or directory, open '/ws/a.txt'")

describe("toIpcError", () => {
  it("uses a tagged failure's message", async () => {
    const err = await rejectionOf(
      Effect.fail(new PathTraversalError({ path: "/etc/passwd", message: "path is outside session working directory" })),
    )
    expect(toIpcError(err).message).toBe("path is outside session working directory")
  })

  it("builds a message for a tagged failure without one from its tag, path and cause", async () => {
    const err = await rejectionOf(Effect.fail(new FileReadError({ path: "/ws/a.txt", cause: enoent() })))
    expect(toIpcError(err).message).toBe(
      "FileReadError (/ws/a.txt): ENOENT: no such file or directory, open '/ws/a.txt'",
    )
  })

  it("includes an id or HTTP status when a tagged failure has no message", async () => {
    const notFound = await rejectionOf(Effect.fail(new ExecutableNotFoundError({ id: "build" })))
    expect(toIpcError(notFound).message).toBe("ExecutableNotFoundError (id: build)")

    const apiError = await rejectionOf(Effect.fail(new GitHubApiError({ status: 404, message: "" })))
    expect(toIpcError(apiError).message).toBe("GitHubApiError (status 404)")
  })

  it("falls back to the bare tag when a tagged failure carries nothing else", async () => {
    const err = await rejectionOf(Effect.fail(new SessionNotFoundError()))
    expect(toIpcError(err).message).toBe("SessionNotFoundError")
  })

  it("uses a GitError's stderr, or the command and exit code when stderr is empty", async () => {
    const withStderr = await rejectionOf(
      Effect.fail(new GitError({ command: "git push", stderr: "remote: Permission denied", exitCode: 128 })),
    )
    expect(toIpcError(withStderr).message).toBe("remote: Permission denied")

    const withoutStderr = await rejectionOf(Effect.fail(new GitError({ command: "git push", stderr: "", exitCode: 128 })))
    expect(toIpcError(withoutStderr).message).toBe("git push failed (exit 128)")
  })

  it("uses a defect's head message for a die", async () => {
    const err = await rejectionOf(
      Effect.sync(() => {
        throw new Error("boom")
      }),
    )
    expect(toIpcError(err).message).toBe("boom")
  })

  it("says the operation was interrupted for an interrupt", async () => {
    const err = await rejectionOf(Effect.interrupt)
    expect(toIpcError(err).message).toBe("The operation was interrupted")
  })

  it("never sends the FiberFailure prefix or stack frames", async () => {
    const failures: Array<Effect.Effect<unknown, unknown>> = [
      Effect.fail(new PathTraversalError({ path: "/x", message: "outside" })),
      Effect.fail(new FileReadError({ path: "/x", cause: enoent() })),
      Effect.fail(new GitError({ command: "git clone", stderr: "", exitCode: 1 })),
      Effect.sync(() => {
        throw new Error("boom")
      }),
      Effect.die("a string defect"),
      Effect.interrupt,
    ]
    for (const program of failures) {
      const err = await rejectionOf(program)
      // Precondition: this is exactly what Electron would otherwise send.
      expect(String(err)).toContain("(FiberFailure)")

      // Electron sends `error.toString()`.
      const sent = toIpcError(err).toString()
      expect(sent).toStartWith("Error: ")
      expect(sent).not.toContain("(FiberFailure)")
      expect(sent).not.toContain("\n    at ")
    }
  })

  it("describes an unwrapped tagged error (boilerplate:render's Cause.squash)", () => {
    expect(toIpcError(new RenderError({ message: "template: unexpected EOF" })).message).toBe("template: unexpected EOF")
    expect(toIpcError(new FileReadError({ path: "/x", cause: enoent() })).message).toMatch(/^FileReadError \(\/x\): ENOENT/)
  })

  it("passes an already-clean Error through unchanged", () => {
    // git.ts's runAndUnwrap and runbook.ts's describeRunbookOpenError throw these.
    const msg = "This path no longer exists:\n\n/tmp/gone"
    expect(toIpcError(new Error(msg)).message).toBe(msg)
  })

  it("keeps the original rejection as the cause for MAIN's own log", async () => {
    const err = await rejectionOf(Effect.fail(new FileReadError({ path: "/x", cause: enoent() })))
    expect(toIpcError(err).cause).toBe(err)
  })
})

describe("describeFailure", () => {
  it("never returns an empty string", () => {
    expect(describeFailure(new Error(""))).toBe("An unknown error occurred")
    expect(describeFailure("")).toBe("An unknown error occurred")
    expect(describeFailure("plain string")).toBe("plain string")
  })
})

describe("installIpcErrorNormalization", () => {
  type Listener = Parameters<IpcMain["handle"]>[1]

  /** Stand-in for ipcMain that records registered listeners. */
  function makeFakeIpc() {
    const listeners = new Map<string, Listener>()
    const ipc: Pick<IpcMain, "handle"> = {
      handle: (channel, listener) => {
        listeners.set(channel, listener)
      },
    }
    return { ipc, listeners }
  }

  /**
   * Invoke a registered listener and return the message the renderer ends up
   * with: Electron sends `error.toString()`, ipcRenderer.invoke wraps it as
   * "Error invoking remote method '<channel>': <sent>", and the preload cleans
   * that with cleanIpcErrorMessage().
   */
  async function rendererMessage(listeners: Map<string, Listener>, channel: string): Promise<string> {
    try {
      await listeners.get(channel)!({} as IpcMainInvokeEvent)
    } catch (err) {
      return cleanIpcErrorMessage(`Error invoking remote method '${channel}': ${(err as Error).toString()}`)
    }
    throw new Error(`expected ${channel} to reject`)
  }

  it("delivers a clean message for a handler that lets runtime.runPromise reject", async () => {
    const { ipc, listeners } = makeFakeIpc()
    installIpcErrorNormalization(ipc)
    ipc.handle("workspace:file", () =>
      runtime.runPromise(Effect.fail(new FileReadError({ path: "/ws/a.txt", cause: enoent() }))),
    )

    expect(await rendererMessage(listeners, "workspace:file")).toBe(
      "FileReadError (/ws/a.txt): ENOENT: no such file or directory, open '/ws/a.txt'",
    )
  })

  it("normalizes synchronous throws too", async () => {
    const { ipc, listeners } = makeFakeIpc()
    installIpcErrorNormalization(ipc)
    ipc.handle("native:open-external", () => {
      throw new TypeError("Invalid URL")
    })

    expect(await rendererMessage(listeners, "native:open-external")).toBe("Invalid URL")
  })

  it("passes arguments through and resolves with the handler's result", async () => {
    const { ipc, listeners } = makeFakeIpc()
    installIpcErrorNormalization(ipc)
    ipc.handle("session:get", (_event, params: { id: string }) => runtime.runPromise(Effect.succeed({ id: params.id })))

    expect(await listeners.get("session:get")!({} as IpcMainInvokeEvent, { id: "s1" })).toEqual({ id: "s1" })
  })
})
