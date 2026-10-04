import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ReactNode } from "react"
import { renderHook, act, cleanup, waitFor } from "@testing-library/react"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { IpcExecutableRegistryProvider } from "@/contexts/IpcExecutableRegistryContext"
import { RunbookContextProvider } from "@/contexts/RunbookContext"
import { useScriptExecution } from "../useScriptExecution"

// A path-based block under the real IpcExecutableRegistryProvider: the block
// reads its script with file:read and asks runbook:script-change how it
// differs from the registry's copy, the provider reads the registry with
// runbook:executables and re-reads it on registry:updated. Only the contexts
// that would need their own providers are stubbed.
vi.mock("@/hooks/useGeneratedFiles", () => {
  const ctx = { updateGeneratedFileTree: () => {} }
  return { useGeneratedFiles: () => ctx }
})
vi.mock("@/contexts/useGitWorkTree", () => {
  const ctx = { invalidateGitFileTree: () => {} }
  return { useGitWorkTree: () => ctx }
})
vi.mock("@/contexts/useLogs", () => {
  const ctx = { registerLogs: () => {} }
  return { useLogs: () => ctx }
})

const SCRIPT_PATH = "scripts/deploy.sh"

interface Version {
  content: string
  contentHash: string
}

const V1: Version = { content: "echo v1", contentHash: "hash-v1" }
const V2: Version = { content: "echo v2", contentHash: "hash-v2" }
const V3: Version = { content: "echo v3", contentHash: "hash-v3" }

// Mock boundary: the preload API. `script` is the file on disk; `registered`
// is the copy the main process's registry holds for the block, which starts
// as `script` unless the file changed before the block mounted.
function createApi(
  initial: { script: Version; registered: Version } = { script: V1, registered: V1 },
) {
  let { script, registered } = initial
  const listeners = new Map<string, Set<(payload?: unknown) => void>>()
  const emit = (channel: string, payload?: unknown) =>
    listeners.get(channel)?.forEach((cb) => cb(payload))
  const invoke = vi.fn(async (channel: string, params?: { contentHash?: string }) => {
    if (channel === "runbook:executables") {
      // The entry ID is derived from the content, as in the main process.
      const id = `e-${registered.contentHash}`
      return {
        executables: {
          [id]: {
            id,
            type: "file",
            componentId: "target",
            componentType: "command",
            contentHash: registered.contentHash,
            path: SCRIPT_PATH,
          },
        },
        warnings: [],
      }
    }
    if (channel === "file:read") {
      return { path: SCRIPT_PATH, ...script, language: "bash", size: script.content.length }
    }
    if (channel === "runbook:script-change") {
      if (script.contentHash === registered.contentHash) return { change: null }
      return {
        change: {
          registeredContent: registered.content,
          diskContent: script.content,
          diskContentHash: script.contentHash,
        },
      }
    }
    if (channel === "runbook:reload-script") {
      if (params?.contentHash !== script.contentHash) {
        throw new Error(`${SCRIPT_PATH} changed again after you reviewed it.`)
      }
      registered = script
      emit("registry:updated")
      return { ok: true }
    }
    return {}
  })
  const on = vi.fn((channel: string, callback: (payload?: unknown) => void) => {
    const set = listeners.get(channel) ?? new Set()
    set.add(callback)
    listeners.set(channel, set)
    return () => {
      set.delete(callback)
    }
  })
  const api = { invoke, on } as unknown as RunbooksAPI
  return {
    api,
    invoke,
    fileReads: () => invoke.mock.calls.filter(([channel]) => channel === "file:read").length,
    changeChecks: () =>
      invoke.mock.calls.filter(([channel]) => channel === "runbook:script-change").length,
    /**
     * The script changed on disk and a watch-mode reload rebuilt the registry
     * from it. runbook.mdx was saved unchanged, so the MDX isn't recompiled
     * and the block stays mounted.
     */
    rebuildRegistry(version: Version) {
      script = version
      registered = version
      emit("registry:updated")
    },
    /** The script changed on disk and the main process's script watcher reported it. */
    editScript(version: Version) {
      script = version
      emit("watch:script-change", { componentIds: ["target"] })
    },
    /** The script watcher reported a write to a script that another block runs. */
    editOtherBlocksScript() {
      emit("watch:script-change", { componentIds: ["other"] })
    },
    /** The script changed on disk and the watcher has not reported it yet. */
    editScriptUnnoticed(version: Version) {
      script = version
    },
  }
}

const originalApi = window.api

beforeEach(() => {
  // useApiExec subscribes to exec:* through window.api directly.
  window.api = {
    invoke: vi.fn(async () => ({})),
    on: vi.fn(() => () => {}),
  } as unknown as typeof window.api
})

afterEach(() => {
  cleanup()
  window.api = originalApi
})

function renderPathBlock(api: RunbooksAPI) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiProvider api={api}>
      <IpcExecutableRegistryProvider>
        <RunbookContextProvider>{children}</RunbookContextProvider>
      </IpcExecutableRegistryProvider>
    </ApiProvider>
  )
  return renderHook(
    () =>
      useScriptExecution({ componentId: "target", componentType: "command", path: SCRIPT_PATH }),
    { wrapper },
  )
}

describe("useScriptExecution — registry reloads", () => {
  it("re-reads its script file when the registry is rebuilt, so it shows what Run executes", async () => {
    const mock = createApi()
    const { result } = renderPathBlock(mock.api)
    await waitFor(() => expect(result.current.sourceCode).toBe("echo v1"))
    expect(result.current.hasScriptDrift).toBe(false)
    const readsBefore = mock.fileReads()

    act(() => mock.rebuildRegistry(V2))

    // Without the re-read, the block would keep showing v1 and warn that it
    // will execute "the version present when first opened", while Run
    // executes v2 from the rebuilt registry.
    await waitFor(() => expect(result.current.sourceCode).toBe("echo v2"))
    expect(mock.fileReads()).toBe(readsBefore + 1)
    expect(result.current.hasScriptDrift).toBe(false)
  })
})

describe("useScriptExecution — a script file that changes on disk", () => {
  it("offers the change for reload and keeps showing the version Run executes", async () => {
    const mock = createApi()
    const { result } = renderPathBlock(mock.api)
    await waitFor(() => expect(result.current.sourceCode).toBe("echo v1"))
    expect(result.current.scriptFileChange).toBeNull()

    act(() => mock.editScript(V2))

    await waitFor(() => expect(result.current.hasScriptDrift).toBe(true))
    expect(result.current.scriptFileChange).toEqual({
      registeredContent: "echo v1",
      diskContent: "echo v2",
      diskContentHash: "hash-v2",
    })
    expect(result.current.sourceCode).toBe("echo v1")
    expect(result.current.rawScriptContent).toBe("echo v1")
  })

  it("does not compare its script when only another block's script was written", async () => {
    const mock = createApi()
    const { result } = renderPathBlock(mock.api)
    await waitFor(() => expect(result.current.sourceCode).toBe("echo v1"))
    await waitFor(() => expect(mock.changeChecks()).toBeGreaterThan(0))
    const checksBefore = mock.changeChecks()

    act(() => mock.editOtherBlocksScript())
    await act(async () => {})

    expect(mock.changeChecks()).toBe(checksBefore)
    expect(result.current.scriptFileChange).toBeNull()
  })

  it("shows the version Run executes when the file had already changed before the block mounted", async () => {
    // file:read returns v2 here, which is not what the registry will run.
    const mock = createApi({ script: V2, registered: V1 })
    const { result } = renderPathBlock(mock.api)

    await waitFor(() => expect(result.current.hasScriptDrift).toBe(true))
    expect(result.current.sourceCode).toBe("echo v1")
  })

  it("reloads the reviewed version, then shows it without a change to review", async () => {
    const mock = createApi()
    const { result } = renderPathBlock(mock.api)
    await waitFor(() => expect(result.current.sourceCode).toBe("echo v1"))
    act(() => mock.editScript(V2))
    await waitFor(() => expect(result.current.hasScriptDrift).toBe(true))

    act(() => result.current.reloadScript())

    await waitFor(() => expect(result.current.sourceCode).toBe("echo v2"))
    expect(mock.invoke).toHaveBeenCalledWith("runbook:reload-script", {
      componentId: "target",
      contentHash: "hash-v2",
    })
    await waitFor(() => expect(result.current.isReloadingScript).toBe(false))
    expect(result.current.hasScriptDrift).toBe(false)
    expect(result.current.scriptFileChange).toBeNull()
    expect(result.current.scriptReloadError).toBeNull()
  })

  it("reports a rejected reload and shows the change that is on disk now", async () => {
    const mock = createApi()
    const { result } = renderPathBlock(mock.api)
    await waitFor(() => expect(result.current.sourceCode).toBe("echo v1"))
    act(() => mock.editScript(V2))
    await waitFor(() => expect(result.current.hasScriptDrift).toBe(true))
    // The user reviewed v2; the file is v3 by the time they click.
    mock.editScriptUnnoticed(V3)

    act(() => result.current.reloadScript())

    await waitFor(() =>
      expect(result.current.scriptReloadError?.message).toBe(
        `${SCRIPT_PATH} changed again after you reviewed it.`,
      ),
    )
    await waitFor(() => expect(result.current.scriptFileChange?.diskContent).toBe("echo v3"))
    expect(result.current.sourceCode).toBe("echo v1")
    expect(result.current.isReloadingScript).toBe(false)
  })

  it("does not check a block that runs an inline command", async () => {
    const mock = createApi()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiProvider api={mock.api}>
        <IpcExecutableRegistryProvider>
          <RunbookContextProvider>{children}</RunbookContextProvider>
        </IpcExecutableRegistryProvider>
      </ApiProvider>
    )
    const { result } = renderHook(
      () =>
        useScriptExecution({
          componentId: "target",
          componentType: "command",
          command: "echo inline",
        }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.sourceCode).toBe("echo inline"))

    act(() => mock.editScript(V2))
    await act(async () => {})

    expect(mock.changeChecks()).toBe(0)
    expect(result.current.scriptFileChange).toBeNull()
  })
})
