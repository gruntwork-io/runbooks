import { describe, it, expect } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { ReactNode } from "react"
import { ErrorReportingProvider } from "./ErrorReportingContext"
import { useErrorReporting } from "./useErrorReporting"

function wrapper({ children }: { children: ReactNode }) {
  return <ErrorReportingProvider>{children}</ErrorReportingProvider>
}

describe("ErrorReportingContext", () => {
  it("starts with zero errors and warnings", () => {
    const { result } = renderHook(() => useErrorReporting(), { wrapper })
    expect(result.current.errorCount).toBe(0)
    expect(result.current.warningCount).toBe(0)
    expect(result.current.errors).toEqual([])
  })

  it("increments errorCount when an error is reported", () => {
    const { result } = renderHook(() => useErrorReporting(), { wrapper })

    act(() => {
      result.current.reportError({
        componentId: "cmd-1",
        componentType: "Command",
        severity: "error",
        message: "Script not found",
      })
    })

    expect(result.current.errorCount).toBe(1)
    expect(result.current.warningCount).toBe(0)
  })

  it("increments warningCount when a warning is reported", () => {
    const { result } = renderHook(() => useErrorReporting(), { wrapper })

    act(() => {
      result.current.reportError({
        componentId: "cmd-1",
        componentType: "Command",
        severity: "warning",
        message: "Missing config",
      })
    })

    expect(result.current.errorCount).toBe(0)
    expect(result.current.warningCount).toBe(1)
  })

  it("counts multiple errors and warnings correctly", () => {
    const { result } = renderHook(() => useErrorReporting(), { wrapper })

    act(() => {
      result.current.reportError({
        componentId: "cmd-1",
        componentType: "Command",
        severity: "error",
        message: "Error 1",
      })
      result.current.reportError({
        componentId: "cmd-2",
        componentType: "Command",
        severity: "error",
        message: "Error 2",
      })
      result.current.reportError({
        componentId: "chk-1",
        componentType: "Check",
        severity: "warning",
        message: "Warning 1",
      })
    })

    expect(result.current.errorCount).toBe(2)
    expect(result.current.warningCount).toBe(1)
    expect(result.current.errors).toHaveLength(3)
  })

  it("updates existing error without creating duplicate", () => {
    const { result } = renderHook(() => useErrorReporting(), { wrapper })

    act(() => {
      result.current.reportError({
        componentId: "cmd-1",
        componentType: "Command",
        severity: "error",
        message: "First error",
      })
    })

    expect(result.current.errors).toHaveLength(1)

    act(() => {
      result.current.reportError({
        componentId: "cmd-1",
        componentType: "Command",
        severity: "error",
        message: "Updated error",
      })
    })

    expect(result.current.errors).toHaveLength(1)
    expect(result.current.errors[0].message).toBe("Updated error")
  })

  it("skips re-render when error is identical", () => {
    const { result } = renderHook(() => useErrorReporting(), { wrapper })

    const error = {
      componentId: "cmd-1",
      componentType: "Command" as const,
      severity: "error" as const,
      message: "Same error",
    }

    act(() => { result.current.reportError(error) })
    const errorsRef1 = result.current.errors

    act(() => { result.current.reportError(error) })
    const errorsRef2 = result.current.errors

    // Same reference means no re-render
    expect(errorsRef1).toBe(errorsRef2)
  })

  it("clearError removes by componentId", () => {
    const { result } = renderHook(() => useErrorReporting(), { wrapper })

    act(() => {
      result.current.reportError({
        componentId: "cmd-1",
        componentType: "Command",
        severity: "error",
        message: "Error 1",
      })
      result.current.reportError({
        componentId: "cmd-2",
        componentType: "Command",
        severity: "error",
        message: "Error 2",
      })
    })

    expect(result.current.errorCount).toBe(2)

    act(() => {
      result.current.clearError("cmd-1")
    })

    expect(result.current.errorCount).toBe(1)
    expect(result.current.errors[0].componentId).toBe("cmd-2")
  })

  it("clearAllErrors resets to zero", () => {
    const { result } = renderHook(() => useErrorReporting(), { wrapper })

    act(() => {
      result.current.reportError({
        componentId: "cmd-1",
        componentType: "Command",
        severity: "error",
        message: "Error 1",
      })
      result.current.reportError({
        componentId: "cmd-2",
        componentType: "Check",
        severity: "warning",
        message: "Warning 1",
      })
    })

    expect(result.current.errorCount).toBe(1)
    expect(result.current.warningCount).toBe(1)

    act(() => {
      result.current.clearAllErrors()
    })

    expect(result.current.errorCount).toBe(0)
    expect(result.current.warningCount).toBe(0)
    expect(result.current.errors).toEqual([])
  })
})
