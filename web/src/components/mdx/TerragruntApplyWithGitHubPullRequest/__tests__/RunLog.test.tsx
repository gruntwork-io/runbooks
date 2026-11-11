import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { RunLog, logEntry } from "../components/RunLog"

const AT = "2026-11-10T12:00:00.000Z"

describe("RunLog", () => {
  it("opens while a run goes, before its first line", () => {
    render(<RunLog blockId="group" log={[]} status="running" />)
    expect(screen.getByRole("button", { name: "View Logs" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(screen.getByText("Running...")).toBeInTheDocument()
  })

  it("shows nothing before a run", () => {
    const { container } = render(<RunLog blockId="group" log={[]} status="pending" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("offers the shared log view's copy and download", () => {
    render(
      <RunLog
        blockId="group"
        log={[{ line: "$ cd /repo && terragrunt plan", at: AT }]}
        status="running"
      />,
    )
    expect(screen.getByText("$ cd /repo && terragrunt plan")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /copy logs/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument()
  })

  it("colors error and warning lines, and keeps when each was written", () => {
    expect(logEntry({ line: "boom", level: "error", at: AT })).toEqual({
      line: "\x1b[31mboom\x1b[0m",
      timestamp: AT,
    })
    expect(logEntry({ line: "fine", at: AT })).toEqual({ line: "fine", timestamp: AT })
  })
})
