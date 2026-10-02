import { describe, it, expect } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { evaluate } from "@mdx-js/mdx"
import * as runtime from "react/jsx-runtime"
import { TestWrapper } from "@/test/test-utils"
import MDXContainer, { rehypeTransformAssetPaths } from "../MDXContainer"

function renderRunbook(content: string) {
  return render(
    <TestWrapper>
      <MDXContainer content={content} runbookPath="testdata/demo/assets" />
    </TestWrapper>,
  )
}

// Waits for the MDX to compile and render, then returns the first element that
// matches `selector` inside the runbook body.
async function findInRunbook(selector: string): Promise<Element> {
  const body = await screen.findByTestId("runbook-content")
  return waitFor(() => {
    const el = body.querySelector(selector)
    expect(el).not.toBeNull()
    return el!
  })
}

describe("MDXContainer asset paths", () => {
  it("rewrites markdown image and link syntax", async () => {
    renderRunbook("![Diagram](./assets/a.png)\n\n[Guide](./assets/guide.pdf)\n")

    expect((await findInRunbook('img[alt="Diagram"]')).getAttribute("src")).toBe(
      "runbook-asset://assets/a.png",
    )
    expect((await screen.findByText("Guide")).closest("a")?.getAttribute("href")).toBe(
      "runbook-asset://assets/guide.pdf",
    )
  })

  it("rewrites an inline JSX <img> (mdxJsxTextElement) and keeps its other attributes", async () => {
    renderRunbook('Status icon <img src="./assets/b.png" width="200" alt="b" /> inline.\n')

    const img = await findInRunbook('img[alt="b"]')
    expect(img.getAttribute("src")).toBe("runbook-asset://assets/b.png")
    expect(img.getAttribute("width")).toBe("200")
  })

  it("rewrites a block JSX <video> with poster and nested <source> (mdxJsxFlowElement)", async () => {
    renderRunbook(
      '<video src="./assets/c.mp4" poster="./assets/p.png" controls>\n' +
        '  <source src="./assets/d.webm" type="video/webm" />\n' +
        "</video>\n",
    )

    const video = await findInRunbook("video")
    expect(video.getAttribute("src")).toBe("runbook-asset://assets/c.mp4")
    expect(video.getAttribute("poster")).toBe("runbook-asset://assets/p.png")
    expect(video.querySelector("source")?.getAttribute("src")).toBe("runbook-asset://assets/d.webm")
  })

  // <embed> and <object> are rejected by remarkLiteralOnly (see
  // web/src/lib/remarkLiteralOnly.test.ts), so they never reach the asset plugin.
  it("rewrites JSX <audio> and <a> asset URLs", async () => {
    renderRunbook(
      '<audio src="./assets/e.mp3" controls />\n\n' +
        'Download the <a href="./assets/f.pdf">guide</a>.\n',
    )

    expect((await findInRunbook("audio")).getAttribute("src")).toBe("runbook-asset://assets/e.mp3")
    expect((await screen.findByText("guide")).closest("a")?.getAttribute("href")).toBe(
      "runbook-asset://assets/f.pdf",
    )
  })

  // A 2x display picks the srcSet candidate, not src, so an unrewritten
  // srcSet breaks the image there even though src loads.
  it("rewrites each srcSet candidate of <img> and <picture><source>, keeping descriptors", async () => {
    renderRunbook(
      "<picture>\n" +
        '  <source srcSet="./assets/g.webp 1x, ./assets/g@2x.webp 2x" type="image/webp" />\n' +
        '  <img src="./assets/g.png" srcSet="./assets/g.png 1x,./assets/g@2x.png 2x" alt="g" />\n' +
        "</picture>\n",
    )

    const img = await findInRunbook('img[alt="g"]')
    expect(img.getAttribute("src")).toBe("runbook-asset://assets/g.png")
    expect(img.getAttribute("srcset")).toBe(
      "runbook-asset://assets/g.png 1x,runbook-asset://assets/g@2x.png 2x",
    )
    expect(img.closest("picture")?.querySelector("source")?.getAttribute("srcset")).toBe(
      "runbook-asset://assets/g.webp 1x, runbook-asset://assets/g@2x.webp 2x",
    )
  })

  it("matches JSX attribute names case-insensitively", async () => {
    renderRunbook(
      '<img srcset="./assets/h.png 1x, ./assets/h@2x.png 2x" SRC="./assets/h.png" alt="h" />\n',
    )

    const img = await findInRunbook('img[alt="h"]')
    expect(img.getAttribute("srcset")).toBe(
      "runbook-asset://assets/h.png 1x, runbook-asset://assets/h@2x.png 2x",
    )
    expect(img.getAttribute("src")).toBe("runbook-asset://assets/h.png")
  })

  it("rewrites a <track> src inside <video>", async () => {
    renderRunbook(
      '<video src="./assets/i.mp4" controls>\n' +
        '  <track src="./assets/i.vtt" kind="captions" srcLang="en" />\n' +
        "</video>\n",
    )

    expect((await findInRunbook("video track")).getAttribute("src")).toBe(
      "runbook-asset://assets/i.vtt",
    )
  })

  it("leaves URLs outside ./assets/ unchanged", async () => {
    renderRunbook(
      '<img src="https://example.com/x.png" alt="remote" />\n\n' +
        '<img src="./images/y.png" alt="other-dir" />\n',
    )

    expect((await findInRunbook('img[alt="remote"]')).getAttribute("src")).toBe(
      "https://example.com/x.png",
    )
    expect((await findInRunbook('img[alt="other-dir"]')).getAttribute("src")).toBe("./images/y.png")
  })
})

describe("rehypeTransformAssetPaths", () => {
  // Markdown can't produce srcSet, but hast stores it (a comma-separated
  // property) as an array of candidates, and a plugin may also leave a string.
  it("rewrites a hast element srcSet given as an array or a string", () => {
    const img = {
      type: "element",
      tagName: "img",
      properties: { srcSet: ["./assets/a.png 1x", "./assets/a@2x.png 2x"] },
    }
    const source = {
      type: "element",
      tagName: "source",
      properties: { srcSet: "./assets/b.webp 1x, ./assets/b@2x.webp 2x" },
    }

    rehypeTransformAssetPaths()({ type: "root", children: [img, source] })

    expect(img.properties.srcSet).toEqual([
      "runbook-asset://assets/a.png 1x",
      "runbook-asset://assets/a@2x.png 2x",
    ])
    expect(source.properties.srcSet).toBe(
      "runbook-asset://assets/b.webp 1x, runbook-asset://assets/b@2x.webp 2x",
    )
  })

  // No block takes a src/href/data/poster prop today, so exercise the plugin
  // through a real MDX compile with a probe component that echoes its props.
  it("leaves props on capitalized components alone", async () => {
    const { default: Content } = await evaluate(
      '<Probe src="./assets/x.png" href="./assets/y.pdf" />\n\n<img src="./assets/z.png" alt="z" />\n',
      { ...runtime, rehypePlugins: [rehypeTransformAssetPaths] },
    )
    const Probe = ({ src, href }: { src?: string; href?: string }) => (
      <span data-testid="probe" data-src={src} data-href={href} />
    )

    const { container } = render(<Content components={{ Probe }} />)

    const probe = screen.getByTestId("probe")
    expect(probe.getAttribute("data-src")).toBe("./assets/x.png")
    expect(probe.getAttribute("data-href")).toBe("./assets/y.pdf")
    // The plugin did run: the sibling HTML tag was rewritten.
    expect(container.querySelector("img")?.getAttribute("src")).toBe("runbook-asset://assets/z.png")
  })
})
