import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ReactNode } from "react"
import { renderHook, act, cleanup, waitFor } from "@testing-library/react"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { IpcExecutableRegistryProvider } from "@/contexts/IpcExecutableRegistryContext"
import { RunbookContextProvider } from "@/contexts/RunbookContext"
import { useScriptExecution } from "../useScriptExecution"

// A path-based block under the real IpcExecutableRegistryProvider: the block
// reads its script with file:read, the provider reads the registry with
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

// Mock boundary: the preload API. `script` is the file on disk as file:read
// returns it; `registryHash` is the hash the main process's registry holds for
// the block.
function createApi() {
  let script = { content: "echo v1", contentHash: "hash-v1" }
  let registryHash = "hash-v1"
  const listeners = new Map<string, Set<() => void>>()
  const invoke = vi.fn(async (channel: string) => {
    if (channel === "runbook:executables") {
      return {
        executables: {
          e1: {
            id: "e1",
            type: "file",
            componentId: "target",
            componentType: "command",
            contentHash: registryHash,
            path: SCRIPT_PATH,
          },
        },
        warnings: [],
      }
    }
    if (channel === "file:read") {
      return { path: SCRIPT_PATH, ...script, language: "bash", size: script.content.length }
    }
    return {}
  })
  const on = vi.fn((channel: string, callback: () => void) => {
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
    /**
     * The script changed on disk and a watch-mode reload rebuilt the registry
     * from it. runbook.mdx was saved unchanged, so the MDX isn't recompiled
     * and the block stays mounted.
     */
    rebuildRegistry(content: string, contentHash: string) {
      script = { content, contentHash }
      registryHash = contentHash
      listeners.get("registry:updated")?.forEach((cb) => cb())
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

    act(() => mock.rebuildRegistry("echo v2", "hash-v2"))

    // Without the re-read, the block would keep showing v1 and warn that it
    // will execute "the version present when first opened", while Run
    // executes v2 from the rebuilt registry.
    await waitFor(() => expect(result.current.sourceCode).toBe("echo v2"))
    expect(mock.fileReads()).toBe(readsBefore + 1)
    expect(result.current.hasScriptDrift).toBe(false)
  })
})
