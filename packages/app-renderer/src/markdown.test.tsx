import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { DocumentBlock, type DocumentView } from "@runbooks/core/protocol"
import { assetUrl, linkTarget, Markdown, unknownParts } from "./markdown.tsx"

// The walk over trees shaped as the engine's parser makes them (mdast, with
// `block` nodes and HTML elements as `{ name, props }`), rendered to the
// markup the page would hold.

type TreeNode = DocumentView["tree"]

const root = (...children: TreeNode[]): TreeNode => ({ type: "root", children })
const p = (...children: TreeNode[]): TreeNode => ({ type: "paragraph", children })
const text = (value: string): TreeNode => ({ type: "text", value })
const el = (name: string, props: Record<string, unknown>, ...children: TreeNode[]): TreeNode => ({
  type: "mdxJsxFlowElement",
  name,
  props,
  children,
})

const SPAN = { start: { line: 3, column: 1 }, end: { line: 5, column: 3 } }
const block = (fields: Record<string, unknown>): DocumentBlock =>
  Schema.decodeUnknownSync(DocumentBlock)({
    _tag: "Configured",
    index: 0,
    tag: "Example",
    block: "Example",
    class: "task",
    span: SPAN,
    step: true,
    ...fields,
  })

const RUNBOOK = "/work/demo/runbook.mdx"
/** The id of the session that has RUNBOOK open: the host of its assets' URLs. */
const SESSION = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"
const ASSETS = `runbook-asset://${SESSION}`

const html = (tree: TreeNode, blocks: ReadonlyArray<DocumentBlock> = []) =>
  renderToStaticMarkup(<Markdown document={{ tree, blocks }} runbook={RUNBOOK} session={SESSION} />)

/** `markup` less the preload hint React's server renderer adds for each image; the window's client render adds none. */
const withoutImagePreloads = (markup: string) =>
  markup.replaceAll(/<link rel="preload" as="image" href="[^"]*"\/>/g, "")

const configError = (file: string, line: number, message: string) => ({
  _tag: "ConfigError",
  code: "badProp",
  message,
  location: { file, span: { start: { line, column: 3 }, end: { line, column: 9 } } },
})

describe("the walk", () => {
  it("renders headings, paragraphs, emphasis and code", () => {
    const shown = html(
      root(
        { type: "heading", depth: 2, children: [text("Setup")] },
        p(
          { type: "emphasis", children: [text("em")] },
          { type: "strong", children: [text("strong")] },
          { type: "delete", children: [text("gone")] },
          { type: "inlineCode", value: "x < y" },
          { type: "break" },
        ),
        { type: "code", lang: "bash", meta: null, value: "echo <hi>" },
        { type: "blockquote", children: [p(text("quoted"))] },
        { type: "thematicBreak" },
      ),
    )
    expect(shown).toBe(
      "<h2>Setup</h2>" +
        "<p><em>em</em><strong>strong</strong><del>gone</del><code>x &lt; y</code><br/></p>" +
        '<pre><code data-language="bash">echo &lt;hi&gt;</code></pre>' +
        "<blockquote><p>quoted</p></blockquote><hr/>",
    )
  })

  it("renders lists, numbered from their start, and task items as checkboxes", () => {
    const item = (checked: boolean | null, ...children: TreeNode[]): TreeNode => ({
      type: "listItem",
      spread: false,
      checked,
      children,
    })
    const shown = html(
      root(
        {
          type: "list",
          ordered: false,
          start: null,
          spread: false,
          children: [item(false, p(text("todo"))), item(true, p(text("done")))],
        },
        {
          type: "list",
          ordered: true,
          start: 3,
          spread: false,
          children: [item(null, p(text("third")))],
        },
      ),
    )
    expect(shown).toBe(
      '<ul><li class="task"><input type="checkbox"/>todo</li>' +
        '<li class="task"><input type="checkbox" checked=""/>done</li></ul>' +
        '<ol start="3"><li>third</li></ol>',
    )
  })

  it("keeps a loose list's paragraphs", () => {
    const shown = html(
      root({
        type: "list",
        ordered: false,
        spread: true,
        children: [{ type: "listItem", spread: true, checked: true, children: [p(text("a"))] }],
      }),
    )
    expect(shown).toBe('<ul><li class="task"><p><input type="checkbox" checked=""/>a</p></li></ul>')
  })

  it("renders a table's first row as its header, aligned by column", () => {
    const row = (...cells: string[]): TreeNode => ({
      type: "tableRow",
      children: cells.map((cell) => ({ type: "tableCell", children: [text(cell)] })),
    })
    const shown = html(
      root({ type: "table", align: ["left", null], children: [row("a", "b"), row("1", "2")] }),
    )
    expect(shown).toBe(
      '<table><thead><tr><th style="text-align:left">a</th><th>b</th></tr></thead>' +
        '<tbody><tr><td style="text-align:left">1</td><td>2</td></tr></tbody></table>',
    )
  })

  it("makes a link clickable only to http, https, mailto or a fragment", () => {
    const link = (url: string): TreeNode => ({ type: "link", url, children: [text("go")] })
    expect(html(p(link("https://example.com/a?b=1")))).toBe(
      '<p><a href="https://example.com/a?b=1">go</a></p>',
    )
    expect(html(p(link("mailto:ops@example.com")))).toBe(
      '<p><a href="mailto:ops@example.com">go</a></p>',
    )
    expect(html(p(link("#setup")))).toBe('<p><a href="#setup">go</a></p>')
    for (const url of [
      "javascript:alert(1)",
      " JaVaScRiPt:alert(1)",
      "vbscript:x",
      "data:text/html,<script>x</script>",
      "file:///etc/passwd",
      "./other/runbook.mdx",
      "runbook-asset://x/a.png",
    ]) {
      const shown = html(p(link(url)))
      expect(shown).not.toContain("<a")
      expect(shown).toContain("go")
      expect(shown).toContain(Bun.escapeHTML(` (${url})`))
    }
  })

  it("resolves a reference link through its definition, which shows nothing itself", () => {
    const shown = html(
      root(p({ type: "linkReference", identifier: "docs", children: [text("the docs")] }), {
        type: "definition",
        identifier: "docs",
        url: "https://example.com/docs",
        title: null,
      }),
    )
    expect(shown).toBe('<p><a href="https://example.com/docs">the docs</a></p>')
  })

  it("renders an image in the runbook's assets/ folder from its runbook-asset URL", () => {
    const shown = html(
      root(
        p({ type: "image", url: "./assets/diagram.png", alt: "The diagram" }),
        p({ type: "imageReference", identifier: "icon", alt: "An icon" }),
        { type: "definition", identifier: "icon", url: "assets/icons/tiny pixel.png", title: null },
        el("img", {
          src: "./assets/pixel.png",
          alt: "A pixel",
          width: "40",
          height: 20,
          title: "dropped",
          style: { position: "fixed" },
          onError: "x",
        }),
      ),
    )
    expect(withoutImagePreloads(shown)).toBe(
      `<p><img src="${ASSETS}/diagram.png" alt="The diagram"/></p>` +
        `<p><img src="${ASSETS}/icons/tiny pixel.png" alt="An icon"/></p>` +
        `<img src="${ASSETS}/pixel.png" alt="A pixel" width="40" height="20"/>`,
    )
  })

  it("renders audio and video in assets/ with their controls, and no other prop", () => {
    const shown = html(
      root(
        el("audio", { src: "assets/tone.wav", controls: true, preload: "auto", loop: true }),
        el("video", {
          src: "./assets/demo.webm",
          poster: "./assets/poster.png",
          controls: true,
          width: 320,
          autoPlay: true,
          onPlay: "x",
        }),
        el(
          "video",
          { controls: true },
          el("source", { src: "./assets/a.webm", type: "video/webm" }),
        ),
        el("video", { src: "./assets/b.webm", poster: "https://example.com/poster.png" }),
      ),
    )
    expect(shown).toBe(
      `<audio src="${ASSETS}/tone.wav" controls="" preload="auto" loop=""></audio>` +
        `<video src="${ASSETS}/demo.webm" poster="${ASSETS}/poster.png" controls="" width="320"></video>` +
        `<video controls=""><source src="${ASSETS}/a.webm"/></video>` +
        `<video src="${ASSETS}/b.webm"></video>`,
    )
  })

  it("shows an image or media outside assets/ as its alt text and URL, and loads nothing", () => {
    const shown = html(
      root(
        p({ type: "image", url: "https://example.com/pixel.gif", alt: "A pixel" }),
        p({ type: "image", url: "./diagram.png", alt: "Beside the runbook" }),
        p({ type: "image", url: "data:image/png;base64,iVBORw0KGgo=", alt: "Data" }),
        p({ type: "imageReference", identifier: "none", alt: "Undefined" }),
        el("img", { src: "file:///etc/passwd", alt: "A file", onError: "x" }),
        el("video", { src: "../assets/demo.mp4", controls: true }),
        el("audio", { src: "https://example.com/tone.wav" }),
        el("video", {}, el("source", { src: "https://example.com/a.webm" })),
      ),
    )
    expect(shown).not.toMatch(/<(img|video|audio|source)/)
    expect(shown).toContain("Image: A pixel (https://example.com/pixel.gif)")
    expect(shown).toContain("Image: Beside the runbook (./diagram.png)")
    expect(shown).toContain("Image: Data (data:image/png;base64,iVBORw0KGgo=)")
    expect(shown).toContain("Image: Undefined")
    expect(shown).toContain("Image: A file (file:///etc/passwd)")
    expect(shown).toContain("Video (../assets/demo.mp4)")
    expect(shown).toContain("Audio (https://example.com/tone.wav)")
    expect(shown).toContain("Media (https://example.com/a.webm)")
  })

  it("renders footnotes, linked by an id apart from the app's", () => {
    const shown = html(
      root(p(text("Note"), { type: "footnoteReference", identifier: "1", label: "1" }), {
        type: "footnoteDefinition",
        identifier: "1",
        label: "1",
        children: [p(text("It."))],
      }),
    )
    expect(shown).toContain('<a href="#user-content-fn-1">1</a>')
    expect(shown).toContain('id="user-content-fn-1"')
  })

  it("creates an HTML element it names with its title and style, and no other prop", () => {
    const shown = html(
      el(
        "div",
        {
          style: { position: "fixed", inset: 0, zIndex: 99999 },
          title: "kept",
          onClick: "alert(1)",
          onclick: "alert(1)",
          id: "root",
          // An app class would let the author mimic the app's own UI.
          class: "block-errors",
          className: "warnings",
          popover: "manual",
        },
        text("inside"),
      ),
    )
    expect(shown).toBe(
      '<div style="position:fixed;inset:0;z-index:99999" title="kept">inside</div>',
    )
  })

  it("drops a style that is not an object of strings and numbers", () => {
    expect(html(el("span", { style: "color: red" }, text("x")))).toBe("<span>x</span>")
    expect(html(el("span", { style: { color: ["red"] } }, text("x")))).toBe("<span>x</span>")
  })

  it("makes an <a> clickable by the same rule, whatever the case of its href", () => {
    expect(html(el("a", { HREF: "https://example.com" }, text("ok")))).toBe(
      '<a href="https://example.com/">ok</a>',
    )
    const refused = html(el("a", { href: "javascript:alert(1)" }, text("no")))
    expect(refused).not.toContain("<a")
    expect(refused).toContain("no")
  })

  it("shows an element it does not create as its children, and counts it", () => {
    const tree = root(
      el("button", { popovertarget: "x" }, text("Press")),
      el("form", { action: "https://example.com" }, el("input", { value: "v" })),
    )
    expect(html(tree)).toBe("Press")
    expect([...unknownParts(tree)]).toEqual([
      ["<button>", 1],
      ["<form>", 1],
      ["<input>", 1],
    ])
  })

  it("shows a node type it does not know as its children or its text, and counts it", () => {
    const tree = root(
      { type: "math", value: "x^2" },
      { type: "container", children: [p(text("held"))] },
      { type: "heading", depth: 9, children: [text("too deep")] },
    )
    expect(html(tree)).toBe("x^2<p>held</p>too deep")
    expect([...unknownParts(tree)]).toEqual([
      ["math", 1],
      ["container", 1],
      ["heading", 1],
    ])
  })

  it("shows raw HTML as its text", () => {
    const shown = html(p({ type: "html", value: '<img src="x" onerror="alert(1)">' }))
    expect(shown).toBe("<p>&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;</p>")
  })

  it("counts nothing in a tree it knows", () => {
    expect(unknownParts(root(p(text("a")), el("kbd", {}, text("K"))))).toEqual(new Map())
  })

  it("renders a block in its frame, with its markdown children inside", () => {
    const shown = html(root({ type: "block", index: 0, children: [p(text("Runs the setup."))] }), [
      block({ id: "setup", title: "Literal title", description: "No substitutions here" }),
    ])
    expect(shown).toContain("&lt;Example&gt;")
    expect(shown).toContain('<span class="block-id">setup</span>')
    expect(shown).toContain('<span class="block-title">Literal title</span>')
    expect(shown).toContain("No substitutions here")
    expect(shown).toContain('<div class="block-body"><p>Runs the setup.</p></div>')
  })

  it("shows a misconfigured block's errors, each with its line, in place of its view", () => {
    const shown = html(root({ type: "block", index: 0, children: [p(text("Runs the setup."))] }), [
      block({
        _tag: "Misconfigured",
        id: "setup",
        errors: [
          configError(RUNBOOK, 7, "set `command`, the script itself, or `path`"),
          configError("/work/demo/scripts/setup.yml", 2, "the YAML does not parse"),
        ],
      }),
    ])
    expect(shown).toContain('<span class="block-id">setup</span>')
    expect(shown).toContain("Line 7: set `command`, the script itself, or `path`")
    expect(shown).toContain("scripts/setup.yml, line 2: the YAML does not parse")
    expect(shown).not.toContain("Runs the setup.")
  })
})

describe("assetUrl", () => {
  it.each([
    ["./assets/a.png", `${ASSETS}/a.png`],
    ["assets/a.png", `${ASSETS}/a.png`],
    ["./assets/icons/tiny pixel.png", `${ASSETS}/icons/tiny pixel.png`],
    ["assets/my%20image.png", `${ASSETS}/my%20image.png`],
    ["./assets/clip.webm#t=2", `${ASSETS}/clip.webm#t=2`],
    ["https://example.com/assets/a.png", undefined],
    ["//example.com/assets/a.png", undefined],
    ["/assets/a.png", undefined],
    ["../assets/a.png", undefined],
    ["./a.png", undefined],
    ["data:image/png;base64,iVBORw0KGgo=", undefined],
    ["file:///work/demo/assets/a.png", undefined],
    ["runbook-asset://other/a.png", undefined],
    ["./ASSETS/a.png", undefined],
    ["assets/", undefined],
    ["assets/../runbook.mdx", undefined],
    ["assets/./a.png", undefined],
    ["assets//a.png", undefined],
    ["assets/%2e%2E/runbook.mdx", undefined],
    ["assets/a%2F..%2F..%2Frunbook.mdx", undefined],
    ["assets/..%5Crunbook.mdx", undefined],
    ["assets\\..\\runbook.mdx", undefined],
    ["assets/%E0%A4%A.png", undefined],
    ["assets/.\t./runbook.mdx", undefined],
    ["assets/a.png\n", undefined],
    ["assets/a.png ", undefined],
    ["", undefined],
  ])("takes %j to %j", (url, asset) => {
    expect(assetUrl(url, SESSION)).toBe(asset)
  })
})

describe("linkTarget", () => {
  it.each([
    ["https://example.com", "https://example.com/"],
    ["HTTP://EXAMPLE.COM/a", "http://example.com/a"],
    ["mailto:a@example.com", "mailto:a@example.com"],
    ["#section", "#section"],
    [" https://example.com", "https://example.com/"],
    ["java\tscript:alert(1)", undefined],
    ["javascript:alert(1)", undefined],
    ["data:text/html,x", undefined],
    ["file:///etc/passwd", undefined],
    ["//example.com/a", undefined],
    ["relative/page", undefined],
    ["", undefined],
  ])("takes %j to %j", (url, target) => {
    expect(linkTarget(url)).toBe(target)
  })
})
