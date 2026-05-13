import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  InputValidator,
  parseAuthDependencies,
  parseTemplateInlineBlocks,
  parseTemplateBlocks,
} from "./validation.ts"

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-validation-"))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeRunbook(content: string): string {
  const p = path.join(tmp, "runbook.mdx")
  fs.writeFileSync(p, content)
  return p
}

// ---------------------------------------------------------------------------
// parseTemplateInlineBlocks
// ---------------------------------------------------------------------------

describe("parseTemplateInlineBlocks", () => {
  it("captures id, outputPath, inputsId, target, and content", () => {
    const p = writeRunbook(`
# Demo

<TemplateInline id="tpl1" outputPath="out.txt" inputsId="i1" target="${"${worktree}"}">
\`\`\`
hello
\`\`\`
</TemplateInline>
`)
    const blocks = parseTemplateInlineBlocks(p)
    const b = blocks.get("tpl1")
    expect(b).toBeDefined()
    expect(b!.outputPath).toBe("out.txt")
    expect(b!.inputsId).toBe("i1")
    expect(b!.target).toBe("${worktree}")
    expect(b!.content.trim()).toBe("hello")
  })

  it("parses generateFile=true variants", () => {
    const p = writeRunbook(`
<TemplateInline id="a" outputPath="a" generateFile="true">x</TemplateInline>
<TemplateInline id="b" outputPath="b" generateFile={true}>y</TemplateInline>
<TemplateInline id="c" outputPath="c">z</TemplateInline>
`)
    const blocks = parseTemplateInlineBlocks(p)
    expect(blocks.get("a")?.generateFile).toBe(true)
    expect(blocks.get("b")?.generateFile).toBe(true)
    expect(blocks.get("c")?.generateFile).toBe(false)
  })

  it("ignores TemplateInline blocks without an id", () => {
    const p = writeRunbook(`<TemplateInline outputPath="x">content</TemplateInline>`)
    expect(parseTemplateInlineBlocks(p).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// parseTemplateBlocks
// ---------------------------------------------------------------------------

describe("parseTemplateBlocks", () => {
  it("captures self-closing Template blocks", () => {
    const p = writeRunbook(
      `<Template id="t1" path="./tpls/foo" inputsId="i1" target="${"${worktree}"}" />`,
    )
    const blocks = parseTemplateBlocks(p)
    const b = blocks.get("t1")
    expect(b).toBeDefined()
    expect(b!.templatePath).toBe("./tpls/foo")
    expect(b!.inputsId).toBe("i1")
    expect(b!.target).toBe("${worktree}")
  })

  it("captures container Template blocks", () => {
    const p = writeRunbook(
      `<Template id="t2" path="./tpls/bar"></Template>`,
    )
    expect(parseTemplateBlocks(p).get("t2")?.templatePath).toBe("./tpls/bar")
  })

  it("ignores Template blocks missing id or path", () => {
    const p = writeRunbook(`
<Template path="./without-id" />
<Template id="without-path" />
`)
    expect(parseTemplateBlocks(p).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// parseAuthDependencies
// ---------------------------------------------------------------------------

describe("parseAuthDependencies", () => {
  it("links a block to its AwsAuth dependency", () => {
    const p = writeRunbook(`
<AwsAuth id="aws1" />
<Command id="cmd1" awsAuthId="aws1">echo hi</Command>
`)
    const deps = parseAuthDependencies(p)
    const d = deps.get("cmd1")
    expect(d).toBeDefined()
    expect(d!.authBlockId).toBe("aws1")
    expect(d!.authBlockType).toBe("AwsAuth")
  })

  it("links a block to its GitHubAuth dependency via githubAuthId", () => {
    const p = writeRunbook(`
<GitHubAuth id="gh1" />
<GitClone id="gc1" githubAuthId="gh1" url="https://github.com/x/y" />
`)
    const deps = parseAuthDependencies(p)
    const d = deps.get("gc1")
    expect(d?.authBlockId).toBe("gh1")
    expect(d?.authBlockType).toBe("GitHubAuth")
  })

  it("ignores auth references inside fenced code blocks", () => {
    const p = writeRunbook(
      "```mdx\n" +
        `<Command id="cmd-in-fence" awsAuthId="aws1">echo</Command>\n` +
        "```\n",
    )
    expect(parseAuthDependencies(p).has("cmd-in-fence")).toBe(false)
  })

  it("returns an empty map when no auth-dependent blocks exist", () => {
    const p = writeRunbook(`<AwsAuth id="aws1" />`)
    expect(parseAuthDependencies(p).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// InputValidator: config error reporting
// ---------------------------------------------------------------------------

describe("InputValidator", () => {
  it("reports unknown block types as config errors", () => {
    const p = writeRunbook(`<MysteryBlock id="x" />`)
    const v = new InputValidator(p)
    v.init()
    expect(v.hasConfigErrors()).toBe(true)
    const err = v.getConfigErrors().find((e) => e.componentType === "MysteryBlock")
    expect(err?.message).toContain("Unknown block type")
  })

  it("ignores unknown blocks inside fenced code", () => {
    const p = writeRunbook("```mdx\n<MysteryBlock id=\"x\" />\n```\n")
    const v = new InputValidator(p)
    v.init()
    const errs = v.getConfigErrors().filter((e) => e.componentType === "MysteryBlock")
    expect(errs).toEqual([])
  })

  it("flags Inputs missing both 'path' and inline content", () => {
    const p = writeRunbook(`<Inputs id="i1" />`)
    const v = new InputValidator(p)
    v.init()
    const err = v.getConfigErrors().find(
      (e) => e.componentType === "Inputs" && e.componentId === "i1",
    )
    expect(err?.message).toContain("Either 'path' prop or inline YAML content is required")
  })

  it("validates inline-YAML inputs schema and enforces enum option", () => {
    const p = writeRunbook(`
<Inputs id="i1">
\`\`\`yaml
variables:
  - name: env
    type: enum
    options: [dev, staging, prod]
\`\`\`
</Inputs>
`)
    const v = new InputValidator(p)
    v.init()
    expect(v.hasConfigErrors()).toBe(false)
    const errs = v.validateInputValues({ "i1.env": "production" })
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toContain("not in enum options")

    const ok = v.validateInputValues({ "i1.env": "dev" })
    expect(ok).toHaveLength(0)
  })
})
