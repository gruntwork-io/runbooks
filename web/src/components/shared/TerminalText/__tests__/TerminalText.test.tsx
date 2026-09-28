import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { TerminalText } from ".."

describe("TerminalText", () => {
  it("links a URL in ANSI-styled output", () => {
    render(<TerminalText text={"\x1b[1mOpen https://github.com/login/device now\x1b[0m"} />)

    const links = screen.getAllByRole("link")
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute("href", "https://github.com/login/device")
    expect(links[0]).toHaveTextContent("https://github.com/login/device")
  })

  it("links a URL that is a whole color span", () => {
    render(<TerminalText text={"PR: \x1b[36mhttps://github.com/acme/infra/pull/12\x1b[0m done"} />)

    expect(screen.getByRole("link")).toHaveAttribute("href", "https://github.com/acme/infra/pull/12")
  })

  it("leaves bare file names in ANSI output as plain text", () => {
    // Guards the classic (non-fuzzy) linkify mode: .tf is a real TLD.
    render(<TerminalText text={"\x1b[32m+ create\x1b[0m main.tf"} />)

    expect(screen.queryAllByRole("link")).toHaveLength(0)
  })

  it("renders no links in ANSI output when linkify is false", () => {
    render(<TerminalText text={"\x1b[1mOpen https://github.com/login/device now\x1b[0m"} linkify={false} />)

    expect(screen.queryAllByRole("link")).toHaveLength(0)
    expect(screen.getByText("Open https://github.com/login/device now")).toBeInTheDocument()
  })

  it("links a URL in plain output", () => {
    render(<TerminalText text="Open https://github.com/login/device now" />)

    expect(screen.getByRole("link")).toHaveAttribute("href", "https://github.com/login/device")
  })
})
