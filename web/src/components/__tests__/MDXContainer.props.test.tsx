import { describe, it, expect } from "vitest"
import { render, screen, within } from "@testing-library/react"
import type { ComponentType, ReactNode } from "react"
import MDXContainer, { compileMDX, MDX_COMPONENTS } from "../MDXContainer"
import { parseMdx } from "../../../../src/mdx"

interface BlockProps {
  name: string
  props: Record<string, unknown>
}

const BLOCK_NAMES = Object.keys(MDX_COMPONENTS).filter((name) => /^[A-Z]/.test(name))

/** The props each block gets when the renderer shows `content`, in document order. */
async function renderedProps(content: string): Promise<BlockProps[]> {
  const Content = (await compileMDX(content)) as ComponentType<{
    components: Record<string, ComponentType<{ children?: ReactNode }>>
  }>
  const rendered: BlockProps[] = []
  const components = Object.fromEntries(
    Object.keys(MDX_COMPONENTS).map((name) => [
      name,
      ({ children, ...props }: { children?: ReactNode }) => {
        if (BLOCK_NAMES.includes(name)) rendered.push({ name, props })
        return <>{children}</>
      },
    ]),
  )
  render(<Content components={components} />)
  return rendered
}

/** The props the main process and the test CLI read for the same blocks (src/mdx.ts). */
function parsedProps(content: string): BlockProps[] {
  const parsed = parseMdx(content)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.elements
    .filter((element) => BLOCK_NAMES.includes(element.name))
    .map(({ name, props }) => ({ name, props }))
}

describe("MDXContainer block props", () => {
  it("are the props the main process reads, whatever form they're written in", async () => {
    const runbook = [
      "---",
      "title: Props",
      "tags: {a: b}",
      "---",
      "",
      String.raw`<Command id="gh" command={"gh repo create org/repo --private && echo \"Done\""} title="Create repo" />`,
      String.raw`<Command id="single" command={'echo it\'s'} />`,
      '<Command id="backticks" command={`echo \\`date\\``} />',
      '<Command id="spaced" command={ "echo hi" } />',
      '<Command id="commented" command={/* note */ "echo hi"} />',
      '<Command id="equals" command = "echo hi" />',
      String.raw`<Command id="redirect" command={'echo it\'s > out.txt'} />`,
      '<Command id="dollar" command={`echo \\${HOME}`} />',
      "<Command id=\"newline\" command={`printf 'a\\nb'`} />",
      '<Command id="jsx-entity" command={"echo &amp; done"} />',
      '<Command id="entities" command="echo &#34;hi&#34; &#x27;x&#x27; &copy;" usePty timeout={300} />',
      "<GoogleAuth id=\"gcp\" detectCredentials={[{ env: { prefix: 'PROD_' } }, 'env']} />",
      '<Admonition type="info">',
      '<Check id="nested" command="echo nested" />',
      "</Admonition>",
      "",
      "```mdx",
      '<Command id="fenced" command={buildCommand()} />',
      "```",
      "",
      'Write `<Command id="inline-code" command={buildCommand()} />` to add one.',
      "",
      '{/* <Command id="in-comment" command="x" /> */}',
      "",
      '| Step | Block |\n| --- | --- |\n| 1 | <Check id="in-table" command="test -f out.txt" /> |',
    ].join("\n")

    const rendered = await renderedProps(runbook)

    expect(rendered.map(({ props }) => props.id ?? props.type)).toEqual([
      "gh",
      "single",
      "backticks",
      "spaced",
      "commented",
      "equals",
      "redirect",
      "dollar",
      "newline",
      "jsx-entity",
      "entities",
      "gcp",
      "info",
      "nested",
      "in-table",
    ])
    expect(parsedProps(runbook)).toEqual(rendered)
  })
})

describe("A runbook MDXContainer refuses", () => {
  it.each([
    // Not valid MDX
    ["an unescaped quote in a prop", '<Command id="c" command="echo \\"x\\"" />'],
    ["a prop that isn't valid JavaScript", '<Command id="c" command={"x" +} />'],
    ["a closing tag that doesn't match", "<Admonition></Check>"],
    // Code, which remarkLiteralOnly refuses
    ["a prop that isn't a literal", '<Command id="c" command={run()} />'],
    ["a template substitution", '<Command id="c" command={`echo ${HOME}`} />'],
    ["a spread prop", '<Command id="c" {...rest} />'],
    ["a __proto__ prop", '<Command id="c" __proto__={{ command: "evil" }} />'],
    ["an expression in text", "Hello {name()} there"],
    ["an export", "export const x = 1"],
    ["a script element", '<script src="./x.js" />'],
    ["a javascript: URL", '<a HREF="javascript:alert(1)">Next step</a>'],
  ])("is refused by the main process too, with the same error: %s", async (_name, code) => {
    // Front matter, so the line in the error is the line in the file for both.
    const runbook = `---\ntitle: Refused\n---\n\n<Command id="before" command="echo hi" />\n\n${code}\n`

    render(<MDXContainer content={runbook} />)
    const details = within(await screen.findByTestId("mdx-error")).getByText(/^Line 7: /)

    expect(parseMdx(runbook)).toEqual({ ok: false, error: details.textContent })
  })
})
