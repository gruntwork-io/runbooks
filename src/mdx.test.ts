import { describe, it, expect } from "bun:test"
import { frontMatter, parseMdx, stringArrayProp, stringProp, stripFrontMatter } from "./mdx.ts"

/** The JSX elements of `content`, which must be valid MDX. */
function elementsOf(content: string) {
  const parsed = parseMdx(content)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.elements
}

/** The props of the single element in `content`. */
function propsOf(content: string) {
  const [element, ...rest] = elementsOf(content)
  expect(rest).toEqual([])
  return element!.props
}

describe("parseMdx", () => {
  describe("reads each prop as the renderer passes it", () => {
    it.each([
      ["a double-quoted string", 'command="echo hi"', "echo hi"],
      ["a single-quoted string", "command='echo hi'", "echo hi"],
      ["spaces around the =", 'command = "echo hi"', "echo hi"],
      [
        "a JSX string with escaped quotes",
        String.raw`command={"gh repo create org/repo --private && echo \"Done\""}`,
        'gh repo create org/repo --private && echo "Done"',
      ],
      [
        "a JSX single-quoted string with an escaped quote",
        String.raw`command={'echo it\'s'}`,
        "echo it's",
      ],
      ["a template literal with escaped backticks", "command={`echo \\`date\\``}", "echo `date`"],
      ["a template literal with an escaped ${", "command={`echo \\${HOME}`}", "echo ${HOME}"],
      ["a template literal with a \\n escape", "command={`printf 'a\\nb'`}", "printf 'a\nb'"],
      ["a JSX string with spaces inside the braces", 'command={ "echo hi" }', "echo hi"],
      ["a JSX string after a comment", 'command={/* note */ "echo hi"}', "echo hi"],
      [
        "a JSX string's character reference, kept as written",
        'command={"echo &amp; done"}',
        "echo &amp; done",
      ],
      [
        "a quoted string's character references, every kind decoded",
        'command="echo &#34;hi&#34; &#x27;x&#x27; &amp; &copy;"',
        "echo \"hi\" 'x' & ©",
      ],
    ])("%s", (_name, prop, expected) => {
      expect(propsOf(`<Command id="c" ${prop} />`).command).toBe(expected)
    })

    it("reads a bare prop as true, and numbers, null, arrays and objects as their values", () => {
      const props = propsOf(
        "<GoogleAuth usePty timeout={300} offset={-5} none={null} " +
          "outputs={[\"region\", 'zone', `x`]} " +
          "detectCredentials={[{ env: { prefix: 'PROD_' } }, 'env']} />",
      )
      expect(props).toEqual({
        usePty: true,
        timeout: 300,
        offset: -5,
        none: null,
        outputs: ["region", "zone", "x"],
        detectCredentials: [{ env: { prefix: "PROD_" } }, "env"],
      })
    })

    it("leaves out a regex or bigint prop, which no block takes", () => {
      expect(propsOf('<Command id="c" pattern={/x/} size={1n} list={[/y/]} />')).toEqual({
        id: "c",
      })
    })

    it("lets a later duplicate prop win, as JSX does", () => {
      expect(propsOf('<Command id="first" id="second" />').id).toBe("second")
    })
  })

  it("finds the blocks after one whose JSX string holds an escaped quote and a >", () => {
    const mdx = [
      String.raw`<Command id="a" command={'echo it\'s > out.txt'} />`,
      "",
      '<Command id="b" command="echo b" />',
      "",
      '<Command id="c">',
      "",
      "Some text.",
      "",
      "</Command>",
    ].join("\n")
    expect(elementsOf(mdx).map((e) => [e.props.id, e.props.command])).toEqual([
      ["a", "echo it's > out.txt"],
      ["b", "echo b"],
      ["c", undefined],
    ])
  })

  it("finds nested blocks in document order, including those in a fragment or a list", () => {
    const mdx = [
      '<Admonition type="info">',
      '<Command id="nested" command="x" />',
      "</Admonition>",
      "",
      "<>",
      '<Check id="in-fragment" command="y" />',
      "</>",
      "",
      '- Step <Command id="inline" command="z" /> inline',
    ].join("\n")
    expect(elementsOf(mdx).map((e) => [e.name, e.props.id])).toEqual([
      ["Admonition", undefined],
      ["Command", "nested"],
      ["Check", "in-fragment"],
      ["Command", "inline"],
    ])
  })

  it("reads no block, and refuses no code, in a code fence, in inline code or in a comment", () => {
    const mdx = [
      "````mdx",
      "```mdx",
      '<Command id="fenced" command={run()} />',
      "```",
      "````",
      "",
      'Write `<Command id="inline-code" command={run()} />` to add one.',
      "",
      '{/* <Command id="commented" command={run()} /> */}',
      "",
      '<Command id="real" command="y" />',
    ].join("\n")
    expect(elementsOf(mdx).map((e) => e.props.id)).toEqual(["real"])
  })

  it("keeps the source between the tags as written, and the props as written", () => {
    const mdx = [
      '<Prerequisites id="tools" title="Tools">',
      "```yaml",
      "tools: [git]",
      "```",
      "</ Prerequisites >",
      '<Inputs id="i">name: x</Inputs>',
      '<Command id="c"  command="a > b" />',
      '<Check id="empty"></Check>',
    ].join("\n")
    expect(elementsOf(mdx).map((e) => [e.content, e.propsSource])).toEqual([
      ["\n```yaml\ntools: [git]\n```\n", 'id="tools" title="Tools"'],
      ["name: x", 'id="i"'],
      ["", 'id="c"  command="a > b"'],
      ["", 'id="empty"'],
    ])
  })

  it("records each element's offset in the source", () => {
    const mdx = 'Intro\n\n<Check id="a" command="echo a" />\n<Check id="b" command="echo b" />\n'
    expect(elementsOf(mdx).map((e) => e.index)).toEqual([
      mdx.indexOf('<Check id="a"'),
      mdx.indexOf('<Check id="b"'),
    ])
  })

  it("skips front matter, which isn't MDX", () => {
    const mdx = '---\ntitle: Deploy\ntags: {a: b}\n---\n<Command id="c" command="x" />\n'
    expect(elementsOf(mdx).map((e) => e.props.id)).toEqual(["c"])
  })

  it("parses GitHub Flavored Markdown, as the renderer does", () => {
    const mdx = '| Step | Block |\n| --- | --- |\n| 1 | <Command id="in-table" command="x" /> |\n'
    expect(elementsOf(mdx).map((e) => e.props.id)).toEqual(["in-table"])
  })

  it("reports where a runbook stops being valid MDX", () => {
    const parsed = parseMdx('# Title\n\n<Command id="c" command="echo \\"Done\\"" />\n')
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.error).toStartWith("Line 3: Unexpected character `\\` (U+005C)")
  })

  describe("gives acorn's reason for JavaScript it can't parse", () => {
    it.each([
      [
        "a string that isn't closed",
        '<Command id="c" command={"echo} />',
        "Unterminated string constant",
      ],
      ["a template that isn't closed", "{`echo}", "Unterminated template"],
      ["an expression that isn't finished", "Total: {1 +} items", "Unexpected token"],
      ["an export that isn't valid", "export const = 1", "Unexpected token"],
    ])("%s", (_name, code, error) => {
      expect(parseMdx(`# Title\n\n${code}\n`)).toEqual({ ok: false, error: `Line 3: ${error}` })
    })
  })

  describe("refuses a runbook with code in it, as the renderer does, saying where", () => {
    it.each([
      [
        "a prop that isn't a literal",
        '<Command id="c" command={run()} />',
        "the `command` prop of <Command> must be a literal value, not {run()}.",
      ],
      [
        "a template substitution",
        '<Command id="c" command={`echo ${HOME}`} />',
        "the `command` prop of <Command> must be a literal value, not {`echo ${HOME}`}.",
      ],
      [
        "a spread prop",
        '<Command id="c" {...rest} />',
        "spread props like {...rest} on <Command> are not allowed in runbooks.",
      ],
      [
        "a __proto__ prop",
        '<Command id="c" __proto__={{ command: "evil" }} />',
        "the `__proto__` prop of <Command> is not allowed in runbooks.",
      ],
      [
        "an expression in text",
        "Hello {name()} there",
        "the expression {name()} is not allowed in runbooks.",
      ],
      [
        "an export",
        "export const x = 1",
        "`import` and `export` statements are not allowed in runbooks.",
      ],
      [
        "a script element",
        '<script src="./x.js" />',
        "<script> elements are not allowed in runbooks.",
      ],
    ])("%s", (_name, code, error) => {
      const parsed = parseMdx(`# Title\n\n${code}\n\n<Command id="after" command="echo hi" />\n`)
      expect(parsed.ok).toBe(false)
      expect(!parsed.ok && parsed.error).toStartWith(`Line 3: ${error}`)
    })
  })
})

describe("stripFrontMatter", () => {
  it("replaces front matter with a blank line per line it spanned", () => {
    expect(stripFrontMatter("---\ntitle: x\n---\n# Body\n")).toBe("\n\n\n# Body\n")
  })

  it("leaves content without front matter, or with unclosed front matter, as it is", () => {
    expect(stripFrontMatter("# Body\n---\n")).toBe("# Body\n---\n")
    expect(stripFrontMatter("---\ntitle: x\n# Body\n")).toBe("---\ntitle: x\n# Body\n")
    // Only a line that is just --- closes it.
    expect(stripFrontMatter("---\ntitle: x\n---oops\n# Body\n")).toBe(
      "---\ntitle: x\n---oops\n# Body\n",
    )
  })

  it("strips empty front matter, and front matter that ends the file", () => {
    expect(stripFrontMatter("---\n---\n# Body\n")).toBe("\n\n# Body\n")
    expect(stripFrontMatter("---\ntitle: x\n---")).toBe("\n\n")
  })
})

describe("frontMatter", () => {
  it("is the YAML between the front matter's delimiters", () => {
    expect(frontMatter('---\ntitle: x\nrunbooks: ">= 0.28"\n---\n# Body\n')).toBe(
      'title: x\nrunbooks: ">= 0.28"',
    )
    expect(frontMatter("---\r\ntitle: x\r\n---\r\n# Body\r\n")).toBe("title: x")
    expect(frontMatter("---\n---\n# Body\n")).toBe("")
    expect(frontMatter("---\ntitle: x\n---")).toBe("title: x")
  })

  it("is null for content without front matter, or with unclosed front matter", () => {
    expect(frontMatter("# Body\n---\ntitle: x\n---\n")).toBeNull()
    expect(frontMatter("---\ntitle: x\n# Body\n")).toBeNull()
    expect(frontMatter("---\ntitle: x\n---oops\n# Body\n")).toBeNull()
  })
})

describe("stringProp", () => {
  it("returns a string prop, and an empty string for any other prop", () => {
    const props = { id: "c", timeout: 300, usePty: true, outputs: ["a"] }
    expect(stringProp(props, "id")).toBe("c")
    expect(stringProp(props, "timeout")).toBe("")
    expect(stringProp(props, "usePty")).toBe("")
    expect(stringProp(props, "outputs")).toBe("")
    expect(stringProp(props, "missing")).toBe("")
  })
})

describe("stringArrayProp", () => {
  it("returns an array of strings, and undefined for any other prop", () => {
    const props = { outputs: ["region", "zone"], empty: [], mixed: ["a", 1], region: "x" }
    expect(stringArrayProp(props, "outputs")).toEqual(["region", "zone"])
    expect(stringArrayProp(props, "empty")).toEqual([])
    expect(stringArrayProp(props, "mixed")).toBeUndefined()
    expect(stringArrayProp(props, "region")).toBeUndefined()
    expect(stringArrayProp(props, "missing")).toBeUndefined()
  })
})
