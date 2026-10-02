import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import MDXContainer from "@/components/MDXContainer"
import { Iframe } from "../Iframe"

function ReportedErrors() {
  const { errors } = useErrorReporting()
  return (
    <ul data-testid="reported-errors">
      {errors.map((e) => (
        <li key={e.componentId}>{e.message}</li>
      ))}
    </ul>
  )
}

// The open runbook's runbook-asset:// host, as runbook:get sends it.
const ASSET_HOST = "rtest"

function renderIframe(props: React.ComponentProps<typeof Iframe>) {
  return render(
    <TestWrapper assetHost={ASSET_HOST}>
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

/** The <webview> the block embeds the page in, once loaded. */
function frame(): HTMLElement | null {
  return document.querySelector("webview")
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

  it("loads an external URL in a webview, with no say over its own session or preload", async () => {
    await renderLoaded({ src: "https://example.com/docs", title: "Example docs" })

    expect(frame()!.getAttribute("title")).toBe("Example docs")
    // The main process picks the session and web preferences (embeds.ts);
    // the tag asks for nothing.
    for (const attribute of [
      "partition",
      "preload",
      "nodeintegration",
      "allowpopups",
      "webpreferences",
    ]) {
      expect(frame()!.hasAttribute(attribute)).toBe(false)
    }
    expect(document.querySelector("iframe")).toBeNull()
    expect(screen.getByRole("link", { name: "Open in browser" })).toHaveAttribute(
      "href",
      "https://example.com/docs",
    )
  })

  it("shows the real host next to the author's title", () => {
    renderIframe({ src: "https://login.evil.example/aws", title: "AWS sign-in" })

    expect(screen.getByText("AWS sign-in")).toBeInTheDocument()
    expect(screen.getByTestId("iframe-location")).toHaveTextContent("login.evil.example")
  })

  it.each([
    ["localhost", "http://localhost:3000/", "localhost:3000"],
    ["127.0.0.1", "http://127.0.0.1:8080/dashboard", "127.0.0.1:8080"],
  ])("loads a plain-http page on %s", async (_name, src, location) => {
    await renderLoaded({ src })

    expect(frame()!.getAttribute("src")).toBe(src)
    expect(screen.getByTestId("iframe-location")).toHaveTextContent(location)
  })

  it("loads a file from the runbook's assets folder over runbook-asset:", async () => {
    await renderLoaded({ src: "./assets/site/index.html" })

    // The runbook's own host gives the page an origin no other runbook's pages share.
    expect(frame()!.getAttribute("src")).toBe(`runbook-asset://${ASSET_HOST}/site/index.html`)
    expect(screen.getByTestId("iframe-location")).toHaveTextContent("./assets/site/index.html")
    expect(screen.queryByRole("link", { name: "Open in browser" })).not.toBeInTheDocument()
  })

  it("rejects an assets path outside an open runbook", async () => {
    render(
      <TestWrapper>
        <Iframe src="./assets/site/index.html" />
        <ReportedErrors />
      </TestWrapper>,
    )

    expect(frame()).toBeNull()
    await waitFor(() =>
      expect(screen.getByTestId("reported-errors")).toHaveTextContent(
        "can only be shown in an open runbook",
      ),
    )
  })

  it.each([
    ["a number of pixels", 320, "320px"],
    ["a string of digits, as on an HTML iframe", "600", "600px"],
    ["a CSS length", "70vh", "70vh"],
  ])("sizes the frame from %s", async (_name, height, css) => {
    await renderLoaded({ src: "https://example.com", height })
    expect(frame()!.style.height).toBe(css)
  })

  it.each([["tall"], ["0"], [-5]])("rejects the height %p", async (height) => {
    renderIframe({ src: "https://example.com", height })

    expect(frame()).toBeNull()
    expect(screen.queryByRole("button", { name: "Load page" })).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId("reported-errors")).toHaveTextContent(`Invalid height "${height}"`),
    )
  })

  it("reloads by replacing the frame", async () => {
    await renderLoaded({ src: "https://example.com" })
    const first = frame()

    await userEvent.click(screen.getByRole("button", { name: "Reload" }))

    expect(frame()).not.toBe(first)
    expect(frame()!.getAttribute("src")).toBe("https://example.com/")
  })

  it.each([
    ["a plain-http URL off the machine", "http://example.com/"],
    ["a plain-http LAN address", "http://192.168.1.10:3000/"],
    ["a plain-http host that only starts with localhost", "http://localhost.evil.example/"],
    ["a plain-http IPv6 loopback address", "http://[::1]:3000/"],
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
    await waitFor(() =>
      expect(screen.getByTestId("reported-errors")).toHaveTextContent(
        "The `src` prop is required.",
      ),
    )
  })

  it("renders from runbook MDX", async () => {
    render(
      <TestWrapper>
        <MDXContainer
          content={'<Iframe src="./assets/site/index.html" title="Dashboard" height={300} />\n'}
          assetHost={ASSET_HOST}
        />
      </TestWrapper>,
    )

    await userEvent.click(await screen.findByRole("button", { name: "Load page" }))

    const webview = screen.getByTestId("runbook-content").querySelector("webview") as HTMLElement
    expect(webview.getAttribute("src")).toBe(`runbook-asset://${ASSET_HOST}/site/index.html`)
    expect(webview.style.height).toBe("300px")
  })
})
