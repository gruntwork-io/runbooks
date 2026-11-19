import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { shownText } from "@/lib/logs"
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

    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://github.com/acme/infra/pull/12",
    )
  })

  it("leaves bare file names in ANSI output as plain text", () => {
    // Guards the classic (non-fuzzy) linkify mode: .tf is a real TLD.
    render(<TerminalText text={"\x1b[32m+ create\x1b[0m main.tf"} />)

    expect(screen.queryAllByRole("link")).toHaveLength(0)
  })

  it("renders no links in ANSI output when linkify is false", () => {
    render(
      <TerminalText
        text={"\x1b[1mOpen https://github.com/login/device now\x1b[0m"}
        linkify={false}
      />,
    )

    expect(screen.queryAllByRole("link")).toHaveLength(0)
    expect(screen.getByText("Open https://github.com/login/device now")).toBeInTheDocument()
  })

  it("links a URL in plain output", () => {
    render(<TerminalText text="Open https://github.com/login/device now" />)

    expect(screen.getByRole("link")).toHaveAttribute("href", "https://github.com/login/device")
  })

  // Log search matches shownText and paints the matches on the rendered line
  // by offset, so the two must agree, through ansi-to-react's quirks too.
  it.each([
    ["plain text", "Apply complete! Resources: 3 added"],
    ["a plain line's backspace, shown as it is", "Draft\b!"],
    ["colors", "\x1b[32mCreation complete\x1b[0m after 2s"],
    ["a colored line's backspaces", "\x1b[32mDraft\b!\x1b[0m Draft"],
    ["a colored line's carriage returns", "50%\r\x1b[32m100%\x1b[0m done\r\n"],
    ["cursor and mode sequences", "\x1b[2K\x1b[1A\x1b[?25l\x1b[32mok\x1b[0m \x1b[>4;2mup"],
    ["a malformed CSI", "\x1b[32mok\x1b[;\x1b[0m"],
    ["an escape that isn't CSI", "\x1b[32mok\x1bM\x1b= next"],
    ["charset and OSC sequences", "\x1b(B\x1b]11;?\x07\x1b[31merror\x1b[0m"],
    ["a URL", "\x1b[36mhttps://github.com/acme/infra/pull/12\x1b[0m opened"],
  ])("shows the text shownText gives, for %s", (_, text) => {
    const { container } = render(<TerminalText text={text} />)
    expect(container.textContent).toBe(shownText(text))
  })
})
