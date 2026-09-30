import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import MDXContainer from "@/components/MDXContainer"
import { Iframe } from "../Iframe"

function ReportedErrors() {
  const { errors } = useErrorReporting()
  return <ul data-testid="reported-errors">{errors.map((e) => <li key={e.componentId}>{e.message}</li>)}</ul>
}

function renderIframe(props: React.ComponentProps<typeof Iframe>) {
  return render(
    <TestWrapper>
      <Iframe {...props} />
      <ReportedErrors />
    </TestWrapper>,
  )
}

/** Render the block and click Load. */
async function renderLoaded(props: React.ComponentProps<typeof Iframe>) {
  const result = renderIframe(props)
  await userEvent.click(screen.getByRole("button", { name: "Load page" }))
  return result
}

function frame(): HTMLIFrameElement | null {
  return document.querySelector("iframe")
}

describe("Iframe", () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it("loads nothing until the user clicks Load", async () => {
    renderIframe({ src: "https://example.com/docs" })

    expect(frame()).toBeNull()
    expect(screen.getByText(/This page runs its own scripts/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Load page" }))

    expect(frame()?.getAttribute("src")).toBe("https://example.com/docs")
  })

  it("stays loaded when the block remounts, as it does on every live reload", async () => {
    const { unmount } = await renderLoaded({ src: "https://example.com" })
    unmount()

    renderIframe({ src: "https://example.com" })

    expect(frame()).not.toBeNull()
  })

  it("loads an external URL in a sandbox that cannot navigate the app", async () => {
    await renderLoaded({ src: "https://example.com/docs", title: "Example docs" })

    expect(frame()!.getAttribute("title")).toBe("Example docs")
    const sandbox = frame()!.getAttribute("sandbox")!.split(" ")
    expect(sandbox).toContain("allow-scripts")
    expect(sandbox).not.toContain("allow-top-navigation")
    expect(screen.getByRole("link", { name: "Open in browser" })).toHaveAttribute("href", "https://example.com/docs")
  })

  it("shows the real host next to the author's title", () => {
    renderIframe({ src: "https://login.evil.example/aws", title: "AWS sign-in" })

    expect(screen.getByText("AWS sign-in")).toBeInTheDocument()
    expect(screen.getByTestId("iframe-location")).toHaveTextContent("login.evil.example")
  })

  it("loads a file from the runbook's assets folder over runbook-asset:", async () => {
    await renderLoaded({ src: "./assets/site/index.html" })

    expect(frame()!.getAttribute("src")).toBe("runbook-asset://assets/site/index.html")
    expect(screen.getByTestId("iframe-location")).toHaveTextContent("./assets/site/index.html")
    expect(screen.queryByRole("link", { name: "Open in browser" })).not.toBeInTheDocument()
  })

  it("sizes the frame from a pixel count or a CSS length", async () => {
    const { unmount } = await renderLoaded({ src: "https://example.com", height: 320 })
    expect(frame()!.style.height).toBe("320px")
    unmount()

    renderIframe({ src: "https://example.com", height: "70vh" })
    expect(frame()!.style.height).toBe("70vh")
  })

  it("reloads by replacing the frame", async () => {
    await renderLoaded({ src: "https://example.com" })
    const first = frame()

    await userEvent.click(screen.getByRole("button", { name: "Reload" }))

    expect(frame()).not.toBe(first)
    expect(frame()!.getAttribute("src")).toBe("https://example.com/")
  })

  it.each([
    ["a file: URL", "file:///etc/hosts"],
    ["a data: URL", "data:text/html,<h1>hi</h1>"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a path outside ./assets/", "./site/index.html"],
    ["an assets path without ./", "assets/site/index.html"],
  ])("rejects %s", async (_name, src) => {
    renderIframe({ src })

    expect(frame()).toBeNull()
    expect(screen.getByText("Invalid Iframe")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId("reported-errors")).toHaveTextContent(`Unsupported src "${src}"`),
    )
  })

  it("rejects a missing src", async () => {
    renderIframe({ src: "" })

    expect(frame()).toBeNull()
    await waitFor(() => expect(screen.getByTestId("reported-errors")).toHaveTextContent("The `src` prop is required."))
  })

  it("renders from runbook MDX", async () => {
    render(
      <TestWrapper>
        <MDXContainer content={'<Iframe src="./assets/site/index.html" title="Dashboard" height={300} />\n'} />
      </TestWrapper>,
    )

    await userEvent.click(await screen.findByRole("button", { name: "Load page" }))

    const iframe = screen.getByTestId("runbook-content").querySelector("iframe")!
    expect(iframe.getAttribute("src")).toBe("runbook-asset://assets/site/index.html")
    expect(iframe.style.height).toBe("300px")
  })
})
