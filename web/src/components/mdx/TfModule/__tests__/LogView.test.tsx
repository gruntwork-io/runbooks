import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { LogView } from "../components/LogView"

describe("LogView", () => {
  it("shows a run that has printed nothing yet, so it's clear it's waiting", () => {
    render(<LogView title="Log" log={[]} running />)
    expect(screen.getByRole("button", { name: /Log \(0 lines\)/ })).toHaveTextContent(
      "Waiting for output…",
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByTestId("tf-module-log")).toHaveTextContent("Waiting for output…")
  })

  it("shows nothing for a finished run with no log", () => {
    const { container } = render(<LogView title="Log" log={[]} running={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the latest line while folded and running", () => {
    render(
      <LogView
        title="Log"
        log={[{ line: "$ cd /repo && terragrunt plan" }, { line: "Downloading module" }]}
        running
      />,
    )
    expect(screen.getByRole("button")).toHaveTextContent("Downloading module")
  })
})
