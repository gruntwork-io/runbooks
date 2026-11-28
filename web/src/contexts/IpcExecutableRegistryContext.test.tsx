import { describe, it, expect } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { ApiProvider, type RunbooksAPI } from "./ApiContext"
import { IpcExecutableRegistryProvider } from "./IpcExecutableRegistryContext"
import { useExecutableRegistry } from "@/hooks/useExecutableRegistry"
import { makeTestApi, type Result } from "@/test/test-api"

/** A registry entry, as runbook:executables sends it. */
type RegisteredExecutable = Result<"runbook:executables">["executables"][string]

function executable(id: string, componentId: string): RegisteredExecutable {
  return {
    id,
    type: "inline",
    componentId,
    componentType: "command",
    contentHash: `hash-${id}`,
    env: {},
    envFrom: [],
    workingDir: "",
    interpreter: "",
  }
}

// Mock boundary: the preload API. `registry` is what runbook:executables
// currently returns; `rebuild()` fires the main process's registry:updated.
function createRegistryApi(initial: Record<string, RegisteredExecutable>) {
  let registry = initial
  const testApi = makeTestApi({
    "runbook:executables": () => ({ executables: registry, warnings: [] }),
  })
  return {
    testApi,
    rebuild(next: Record<string, RegisteredExecutable>) {
      registry = next
      testApi.emit("registry:updated")
    },
  }
}

function renderRegistry(api: RunbooksAPI) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiProvider api={api}>
      <IpcExecutableRegistryProvider>{children}</IpcExecutableRegistryProvider>
    </ApiProvider>
  )
  return renderHook(() => useExecutableRegistry(), { wrapper })
}

describe("IpcExecutableRegistryProvider", () => {
  it("loads the registry on mount without probing runbook:get", async () => {
    const registryApi = createRegistryApi({ e1: executable("e1", "greet") })
    const { result } = renderRegistry(registryApi.testApi.api)

    await waitFor(() => expect(result.current.getExecutableByComponentId("greet")?.id).toBe("e1"))
    expect(registryApi.testApi.calls.map(({ channel }) => channel)).toEqual(["runbook:executables"])
  })

  it("re-fetches when the main process rebuilds the registry", async () => {
    const registryApi = createRegistryApi({ e1: executable("e1", "greet") })
    const { result } = renderRegistry(registryApi.testApi.api)
    await waitFor(() => expect(result.current.getExecutableByComponentId("greet")?.id).toBe("e1"))
    // The load on mount isn't a rebuild: blocks have nothing to re-read yet.
    expect(result.current.registryVersion).toBe(0)

    act(() => registryApi.rebuild({ e2: executable("e2", "greet") }))

    await waitFor(() => expect(result.current.getExecutableByComponentId("greet")?.id).toBe("e2"))
    expect(result.current.getExecutableByComponentId("missing")).toBeNull()
    expect(result.current.registryVersion).toBe(1)
  })
})
