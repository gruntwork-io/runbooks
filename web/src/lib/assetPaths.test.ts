import { describe, it, expect } from "vitest"
import { rewriteAssetUrl } from "./assetPaths"

describe("rewriteAssetUrl", () => {
  it("rewrites ./assets/ URLs in the listed attributes only", () => {
    expect(rewriteAssetUrl("img", "src", "./assets/a.png")).toBe("runbook-asset://assets/a.png")
    expect(rewriteAssetUrl("video", "poster", "./assets/p.png")).toBe(
      "runbook-asset://assets/p.png",
    )
    expect(rewriteAssetUrl("track", "src", "./assets/c.vtt")).toBe("runbook-asset://assets/c.vtt")
    expect(rewriteAssetUrl("img", "alt", "./assets/a.png")).toBe("./assets/a.png")
    expect(rewriteAssetUrl("div", "src", "./assets/a.png")).toBe("./assets/a.png")
    expect(rewriteAssetUrl("constructor", "src", "./assets/a.png")).toBe("./assets/a.png")
    expect(rewriteAssetUrl("img", "src", "assets/a.png")).toBe("assets/a.png")
  })

  it("matches attribute names case-insensitively", () => {
    expect(rewriteAssetUrl("img", "SRC", "./assets/a.png")).toBe("runbook-asset://assets/a.png")
    expect(rewriteAssetUrl("img", "srcset", "./assets/a.png 2x")).toBe(
      "runbook-asset://assets/a.png 2x",
    )
    expect(rewriteAssetUrl("source", "srcSet", "./assets/a.webp")).toBe(
      "runbook-asset://assets/a.webp",
    )
  })

  describe("srcSet", () => {
    const srcSet = (value: string) => rewriteAssetUrl("img", "srcSet", value)

    it("rewrites each candidate URL and keeps descriptors and spacing", () => {
      expect(srcSet("./assets/a.png 1x, ./assets/a@2x.png 2x")).toBe(
        "runbook-asset://assets/a.png 1x, runbook-asset://assets/a@2x.png 2x",
      )
      expect(srcSet("./assets/s.png 480w,\n  ./assets/l.png 1080w")).toBe(
        "runbook-asset://assets/s.png 480w,\n  runbook-asset://assets/l.png 1080w",
      )
      expect(srcSet("./assets/a.png,./assets/b.png 2x")).toBe(
        "runbook-asset://assets/a.png,runbook-asset://assets/b.png 2x",
      )
    })

    it("leaves candidates outside ./assets/ unchanged", () => {
      expect(srcSet("https://example.com/a.png 1x, ./assets/b.png 2x")).toBe(
        "https://example.com/a.png 1x, runbook-asset://assets/b.png 2x",
      )
      // A comma inside a URL splits it, but only a piece starting with ./assets/ changes
      expect(srcSet("data:image/png;base64,iVBORw0KGgo= 1x")).toBe(
        "data:image/png;base64,iVBORw0KGgo= 1x",
      )
    })
  })
})
