import { describe, it, expect } from "vitest"
import { render, act } from "@testing-library/react"
import type { LogEntry } from "@/hooks/useApiExec"
import type { LogsContextType } from "./LogsContext.types"
import { LogsProvider } from "./LogsContext"
import { useLogs } from "./useLogs"

function line(text: string): LogEntry {
  return { line: text, timestamp: "2026-01-01T00:00:00Z" }
}

/**
 * Renders the real provider with two useLogs() consumers (standing in for a
 * Command/Check block and the Header) and counts how often each renders.
 */
function renderWithConsumers() {
  const renders = { block: 0, header: 0 }
  let ctx!: LogsContextType

  function Block() {
    ctx = useLogs()
    renders.block++
    return null
  }
  function Header() {
    const { hasLogs } = useLogs()
    renders.header++
    return <span data-testid="has-logs">{String(hasLogs)}</span>
  }

  const utils = render(
    <LogsProvider>
      <Block />
      <Header />
    </LogsProvider>
  )
  return { ...utils, renders, ctx: () => ctx }
}

describe("LogsContext", () => {
  it("does not re-render consumers for each new log line once logs exist", () => {
    const { renders, ctx, getByTestId } = renderWithConsumers()
    expect(getByTestId("has-logs").textContent).toBe("false")

    // A block registers a fresh array for every streamed line.
    const logs: LogEntry[] = []
    logs.push(line("line 1"))
    act(() => ctx().registerLogs("block-a", [...logs]))
    expect(getByTestId("has-logs").textContent).toBe("true")
    const afterFirst = { ...renders }

    for (let i = 2; i <= 50; i++) {
      logs.push(line(`line ${i}`))
      act(() => ctx().registerLogs("block-a", [...logs]))
    }
    act(() => ctx().registerLogs("block-b", [line("other block")]))

    expect(renders).toEqual(afterFirst)
  })

  it("does not re-render consumers when only empty logs are registered", () => {
    const { renders, ctx } = renderWithConsumers()
    const initial = { ...renders }

    act(() => ctx().registerLogs("block-a", []))
    act(() => ctx().registerLogs("block-b", []))

    expect(renders).toEqual(initial)
  })

  it("getAllLogs returns the latest registered logs even though consumers did not re-render", () => {
    const { ctx } = renderWithConsumers()

    act(() => ctx().registerLogs("block-a", [line("a1")]))
    act(() => ctx().registerLogs("block-a", [line("a1"), line("a2")]))
    act(() => ctx().registerLogs("block-b", [line("b1")]))

    const all = ctx().getAllLogs()
    expect(all.get("block-a")?.map(l => l.line)).toEqual(["a1", "a2"])
    expect(all.get("block-b")?.map(l => l.line)).toEqual(["b1"])

    // The returned map is a snapshot, not the provider's own storage.
    all.delete("block-a")
    expect(ctx().getAllLogs().has("block-a")).toBe(true)
  })

  it("flips hasLogs back to false when every block's logs are emptied", () => {
    const { ctx, getByTestId } = renderWithConsumers()

    act(() => ctx().registerLogs("block-a", [line("a1")]))
    expect(getByTestId("has-logs").textContent).toBe("true")

    act(() => ctx().registerLogs("block-a", []))
    expect(getByTestId("has-logs").textContent).toBe("false")
  })

  it("clearLogs drops every block's logs and resets hasLogs", () => {
    const { ctx, getByTestId } = renderWithConsumers()
    act(() => ctx().registerLogs("block-a", [line("a1")]))

    act(() => ctx().clearLogs())

    expect(getByTestId("has-logs").textContent).toBe("false")
    expect(ctx().getAllLogs().size).toBe(0)
  })
})
