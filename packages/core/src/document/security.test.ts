/**
 * The "MDX is literal only" security tests (baseline/security-tests.ts),
 * ported by name from src/remarkLiteralOnly.test.ts and
 * web/src/components/__tests__/MDXContainer.security.test.tsx. The renderer
 * no longer compiles MDX: the parser refuses the runbook, so no client gets
 * a document to show or run.
 */
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import { parseRunbook } from "./parse.ts"

const parse = (source: string) =>
  parseRunbook(source, TOY_REGISTRY, { file: "runbook.mdx", appVersion: "0.31.0" })

/** The codes of the errors `source` gets, each once. */
const codes = (source: string) => {
  const result = parse(source)
  return result._tag === "Parsed" ? [] : [...new Set(result.errors.map((error) => error.code))]
}

const firstRefusal = (source: string) => {
  const result = parse(source)
  if (result._tag === "Parsed") throw new Error("parsed")
  const refusal = result.errors.find((error) => error.code === "notAllowed")
  if (refusal === undefined) throw new Error(`no refusal in ${result.errors[0].message}`)
  return refusal
}

describe("remarkLiteralOnly", () => {
  describe("allows literal-only MDX", () => {
    it.each([
      ["plain string props", '<Note type="info" title="Heads up" />'],
      ["bare boolean props", "<Note allowPermanentHide />"],
      ["boolean expressions", "<X generateFile={true} />"],
      ["string expressions", `<Run id={'a'} command={"echo hi"} />`],
      [
        "template strings without substitutions",
        '<Run command={`echo "$HOME" > "$GENERATED_FILES/x"`} />',
      ],
      ["signed numbers, null and regexes", "<X a={-1} b={+2.5} c={0} d={null} e={/ab+c/i} />"],
      ["arrays of literals", '<Run args={["a", "b", 3]} />'],
      [
        "nested objects and arrays",
        `<X detectCredentials={[{ env: { prefix: 'PROD_' } }, 'env']} />`,
      ],
      ["quoted object keys", `<X a={{ 'quoted-key': 1, plain: [true, false] }} />`],
      ["comments", "Before\n\n{/* a comment */}\n\nInline {/* comment */} text"],
      ["empty expressions", "Before\n\n{}\n\nAfter"],
      ["literal text and flow expressions", `Price: {'$5'}\n\n{"A literal paragraph"}`],
      ["nested blocks", '<Note title="Outer">\n  <Run args={["x"]} />\n</Note>'],
      [
        "plain HTML elements",
        '<div style="color: red;">\nRed text\n</div>\n\nInline <img src="./x.png" alt="x" /> image',
      ],
      [
        "object keys that only resemble __proto__",
        `<X a={{ proto: 1, '__proto': 2, constructor: 3 }} />`,
      ],
      // A capitalized name is a block, even when its lowercase is a blocked element.
      ["a block whose name matches a blocked element", '<Script src="https://example.com" />'],
      [
        "links and text that only mention javascript:",
        '<a href="https://example.com/javascript:">Docs</a>\n\n<Run command="echo javascript: is off" />',
      ],
      [
        "markdown links and images that only mention javascript:",
        "[Docs](https://example.com/javascript:) and [javascript: links](./javascript.md)\n\n![Logo](./javascript.png)\n\n[More][more]\n\n[more]: ./javascript:more.md",
      ],
    ])("%s", (_name, source) => {
      // Unknown toy tags and missing ids are other errors; none is a refusal.
      expect(codes(source)).not.toContain("notAllowed")
      expect(codes(source)).not.toContain("syntax")
    })
  })

  describe("rejects anything that runs JavaScript", () => {
    it.each([
      ["an export", "export const x = 1"],
      ["an import", "import x from './x.js'"],
      ["a call in a flow expression", "{alert(1)}"],
      ["a call in a text expression", "Hello {name()} there"],
      ["an identifier", "{window}"],
      ["a member expression", "{window.api}"],
      ["a binary expression", "{1 + 1}"],
      ["a sequence expression", "{(1, alert(1))}"],
      ["a call in a prop", "<X a={f()} />"],
      ["an identifier prop", "<X a={undefined} />"],
      ["a template substitution", "<X a={`${f()}`} />"],
      ["a spread prop", "<X {...props} />"],
      ["an array spread", "<X a={[...xs]} />"],
      ["an array hole", "<X a={[1, , 2]} />"],
      ["a computed object key", "<X a={{ [k]: 1 }} />"],
      ["a shorthand property", "<X a={{ k }} />"],
      ["an object method", "<X a={{ m() { return 1 } }} />"],
      ["a getter", "<X a={{ get g() { return 1 } }} />"],
      ["an object spread", "<X a={{ ...o }} />"],
      ["an arrow function", "<X a={() => 1} />"],
      ["a negated identifier", "<X a={-x} />"],
      ["a non-numeric unary", "<X a={!0} />"],
      ["a call nested in a literal", "<X a={[{ b: f() }]} />"],
      ["a call in nested block children", "<Note>\n  {f()}\n</Note>"],
      ["a script element", '<script async src="file:///tmp/x.js" />'],
      ["an iframe element", '<iframe src="./page.html" />'],
      ["a frame element", '<frame src="./page.html" />'],
      ["an object element", '<object data="./page.html" />'],
      ["an embed element", '<embed src="./page.svg" />'],
      ["a webview element", '<webview src="https://example.com" />'],
      ["a mixed-case blocked element", '<iFrame src="./page.html" />'],
      [
        "dangerouslySetInnerHTML",
        `<div dangerouslySetInnerHTML={{ __html: '<img src=x onerror="alert(1)">' }} />`,
      ],
      ["a srcDoc prop", `<div srcDoc="<script>alert(1)</script>" />`],
      ["a lowercase srcdoc prop", `Inline <span srcdoc="<script>alert(1)</script>" /> text`],
      [
        "a custom element",
        '<x-widget style={{ animationName: "spin" }} ONANIMATIONSTART="alert(1)" />',
      ],
      ["a custom element in text", 'Hello <x-widget oNfocus="alert(1)" /> there'],
      ["a dotted element name", "<Note.constructor />"],
      ["a namespaced script element", '<svg>\n  <svg:script href="file:///tmp/x.js" />\n</svg>'],
      [
        "a namespaced script element with inline code",
        "<svg><svg:script>window.pwned = 'x'</svg:script></svg>",
      ],
      [
        "a namespaced element with another prefix",
        '<svg><html:script href="file:///tmp/x.js" /></svg>',
      ],
      ["a __proto__ prop", '<Note __proto__={["a=1"]} />'],
      ["a __proto__ object key", '<X a={{ __proto__: ["a=1"] }} />'],
      ["a quoted __proto__ object key", `<X a={[{ '__proto__': { b: 1 } }]} />`],
      // React only sanitizes `javascript:` URLs in `href`, `src`, `action`,
      // `formAction` and `xlinkHref` spelled exactly so.
      ["a javascript: URL in an uppercase HREF", '<a HREF="javascript:alert(1)">Next step</a>'],
      [
        "a javascript: URL in a lowercase formaction",
        '<form><button formaction="javascript:alert(1)">Go</button></form>',
      ],
      [
        "a javascript: URL in a namespaced xlink:href",
        '<svg><a xlink:href="javascript:alert(1)"><text>Go</text></a></svg>',
      ],
      [
        "a javascript: URL in an SVG animation value list",
        '<svg><a><animate attributeName="href" values="#;javascript:alert(1)" /><text>Go</text></a></svg>',
      ],
      ["an obfuscated javascript: URL", '<a Href=" &#x6A;ava&#x09;script&colon;alert(1)">Go</a>'],
      ["a javascript: URL in a literal expression", "<a HREF={`javascript:alert(1)`}>Go</a>"],
      ["a javascript: URL in an array", `<a HREF={['javascript:alert(1)']}>Go</a>`],
      ["a javascript: URL in an exactly spelled href", '<a href="javascript:alert(1)">Go</a>'],
      ["a javascript: URL in a markdown link", "[Next step](javascript:alert(1))"],
      [
        "an obfuscated javascript: URL in a markdown link",
        "[Go](&#x6A;ava&#x09;script&colon;alert(1))",
      ],
      ["a javascript: URL in a markdown image", "![Diagram](javascript:alert(1))"],
      [
        "a javascript: URL in a reference link's definition",
        "[Next step][go]\n\n[go]: javascript:alert(1)",
      ],
      [
        "a javascript: URL in a markdown link in a block",
        "<Note>\n[Go](javascript:alert(1))\n</Note>",
      ],
    ])("%s", (_name, source) => {
      expect(firstRefusal(source).message).toMatch(
        /not allowed in runbooks|must be a literal value/,
      )
    })
  })

  describe("rejects elements that hand the app another document to load", () => {
    it.each([
      [
        "a meta refresh to a javascript: URL",
        '<meta http-equiv="refresh" content="0;url=javascript:alert(1)" />',
        "meta",
      ],
      [
        "a meta refresh to another page",
        '<meta http-equiv="refresh" content="0; url=https://example.com/" />',
        "meta",
      ],
      ["a base element", '<base href="https://example.com/" />', "base"],
      ["a stylesheet link", '<link rel="stylesheet" href="https://example.com/x.css" />', "link"],
      [
        "a prefetch link",
        'Inline <link rel="prefetch" href="https://example.com/next" /> text',
        "link",
      ],
    ])("%s", (_name, source, element) => {
      expect(firstRefusal(source).message).toBe(
        `<${element}> elements are not allowed in runbooks.`,
      )
    })
  })

  it("names the line, prop and block in the error", () => {
    const prop = firstRefusal('# Title\n\n<Run id="a" command={run()} />')
    expect(prop.location).toMatchObject({ block: { tag: "Run" }, prop: "command" })
    expect(prop.location.span.start.line).toBe(3)
    expect(prop.message).toStartWith(
      "the `command` prop of <Run> must be a literal value, not {run()}.",
    )

    const esm = firstRefusal("# Title\n\nexport const x = 1")
    expect(esm.location.span.start.line).toBe(3)
    expect(esm.message).toStartWith(
      '`import` and `export` statements are not allowed in runbooks. Remove "export const x = 1".',
    )

    const html = firstRefusal('# Title\n\n<div srcDoc="x" />')
    expect(html.location).toMatchObject({ prop: "srcDoc" })
    expect(html.location.span.start.line).toBe(3)
    expect(html.message).toBe("the `srcDoc` prop of <div> is not allowed in runbooks.")

    const url = firstRefusal('# Title\n\n<a HREF="javascript:alert(1)">Go</a>')
    expect(url.location.span.start.line).toBe(3)
    expect(url.message).toBe(
      "`javascript:` URLs like the `HREF` prop of <a> are not allowed in runbooks.",
    )
  })

  it("names the line of a markdown link, image or definition that has a javascript: URL", () => {
    const at = (source: string) => {
      const { location, message } = firstRefusal(source)
      return [location.span.start.line, message]
    }
    expect(at("# Title\n\nSee [the next step](javascript:alert(1)).")).toEqual([
      3,
      "`javascript:` URLs like this link's are not allowed in runbooks.",
    ])
    expect(at("# Title\n\n![Diagram](javascript:alert(1))")).toEqual([
      3,
      "`javascript:` URLs like this image's are not allowed in runbooks.",
    ])
    // A reference link has no URL of its own: its definition, where the author fixes it, has.
    expect(at("# Title\n\n[Next step][go]\n\n[go]: javascript:alert(1)")).toEqual([
      5,
      "`javascript:` URLs like this link definition's are not allowed in runbooks.",
    ])
  })
})

const EXEC = `window.api.invoke('exec:run', { executableId: 'abc' })`
const ATTACKS: Array<[string, string]> = [
  ["an export", `export const _ = ${EXEC}\n\n# Title`],
  [
    "an import",
    `import x from "data:text/javascript,${encodeURIComponent(`${EXEC}; export default 1`)}"\n\n# Title`,
  ],
  ["a call expression", `# Title\n\n{${EXEC}}`],
  ["a text expression", `Hello {String(${EXEC})} there`],
  ["a prop expression", `<Note type="info" title={String(${EXEC})} />`],
  ["a spread prop", `<Note type="info" {...${EXEC}} />`],
  ["a template substitution", `<Note type="info" title={\`\${${EXEC}}\`} />`],
  [
    "a namespaced script element",
    `<svg><svg:script>window.api.invoke('runbook:executables')</svg:script></svg>`,
  ],
  ["a javascript: URL in an uppercase HREF", `<a HREF="javascript:${EXEC}">Next step</a>`],
]

describe("MDXContainer — runbook code cannot run on open", () => {
  // A refused runbook has no document, so no client has anything to render,
  // and the engine has no block to run.
  it.each(ATTACKS)("rejects %s and never calls the API", (_name, content) => {
    const result = parse(content)
    expect(result._tag).toBe("Invalid")
    expect(firstRefusal(content).message).toMatch(/not allowed in runbooks|must be a literal value/)
  })

  it("still renders literal props, comments and template strings", () => {
    const content = [
      "# Literal props",
      "",
      "{/* an author comment */}",
      "",
      "<Note type=\"info\" title={'Literal title'} description={`No substitutions here`} />",
    ].join("\n")
    const result = parse(content)
    if (result._tag !== "Parsed") throw new Error(result.errors[0].message)
    expect(result.document.blocks[0]?.props).toEqual({
      type: "info",
      title: "Literal title",
      description: "No substitutions here",
    })
    // The comment renders nothing: the heading, then the block.
    expect(result.document.tree.children?.map((node) => node.type)).toEqual(["heading", "block"])
  })

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("names the runbook file line when there is front matter (%s)", (_name, eol) => {
    const content = [
      "---",
      "title: Front matter",
      "---",
      "",
      "# Title",
      "",
      '<Run id="a" command={run()} />',
    ].join(eol)
    const refusal = firstRefusal(content)
    expect(refusal.location.span.start.line).toBe(7)
    expect(refusal.message).toStartWith("the `command` prop of <Run> must be a literal value")
  })
})

// Every runbook shipped as test data or as an e2e fixture stays within the
// literal-only rules.
const REPO_ROOT = resolve(import.meta.dirname, "../../../..")
const RUNBOOK_DIRS = ["testdata", join("test", "fixtures", "runbooks")]
const runbooksIn = (dir: string) =>
  readdirSync(resolve(REPO_ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => join(dir, file))
    .sort()

describe("compileMDX — shipped runbooks", () => {
  it.each(RUNBOOK_DIRS)("finds the runbooks under %s", (dir) => {
    expect(runbooksIn(dir).length).toBeGreaterThan(0)
  })

  it.each(RUNBOOK_DIRS.flatMap(runbooksIn))("compiles %s", (file) => {
    const found = codes(readFileSync(resolve(REPO_ROOT, file), "utf8"))
    expect(found).not.toContain("notAllowed")
    expect(found).not.toContain("syntax")
  })
})
