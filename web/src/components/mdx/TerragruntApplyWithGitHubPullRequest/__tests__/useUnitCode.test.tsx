import { describe, it, expect, vi } from "vitest"
import type { ReactNode } from "react"
import { renderHook, waitFor } from "@testing-library/react"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { SimulationContext } from "@/contexts/SimulationContext.types"
import { useUnitCode } from "../hooks/useUnitCode"

describe("useUnitCode", () => {
  it("renders the code again when the simulation's answers change", async () => {
    let renders = 0
    const invoke = vi.fn(() => Promise.resolve({ kind: "workspace", files: [], render: ++renders }))
    const api = { invoke } as unknown as RunbooksAPI
    const contexts = [0, 1].map((revision) => ({
      state: { enabled: true as const, scenarios: [] },
      setScenario: () => {},
      revision,
    }))
    let context = contexts[0]!
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiProvider api={api}>
        <SimulationContext.Provider value={context}>{children}</SimulationContext.Provider>
      </ApiProvider>
    )
    const values = { id: "platform@example.com" }
    const ref = { source: "google-group", template: "templates/google-group-unit" }
    const { rerender } = renderHook(() => useUnitCode("group", ref, values, undefined, true), {
      wrapper,
    })
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))

    context = contexts[1]!
    rerender()
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
  })
})
