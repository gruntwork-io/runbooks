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

  it("keeps the real block when a later fenced example reuses its id", () => {
    const p = writeRunbook(`
<TemplateInline id="cfg" outputPath="real.txt">
\`\`\`
real content
\`\`\`
</TemplateInline>

\`\`\`\`mdx
<TemplateInline id="cfg" outputPath="example.txt">
\`\`\`
example content
\`\`\`
</TemplateInline>
\`\`\`\`
`)
    const b = parseTemplateInlineBlocks(p).get("cfg")
    expect(b?.content).toBe("real content\n")
    expect(b?.outputPath).toBe("real.txt")
    // The executor looks this map up by the id of the block the validator lists
    const v = new InputValidator(p)
    v.init()
    const comps = v.getComponents()
    expect(comps).toHaveLength(1)
    expect(comps[0]!.props).toContain('outputPath="real.txt"')
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
    expect(b!.inputsIds).toEqual(["i1"])
    expect(b!.target).toBe("${worktree}")
  })

  it("captures every id of an inputsId list, in order, and none without the prop", () => {
    const p = writeRunbook(`
<Template id="list" path="./tpls/foo" inputsId={["base", 'env']} />
<Template id="none" path="./tpls/foo" />
`)
    const blocks = parseTemplateBlocks(p)
    expect(blocks.get("list")?.inputsIds).toEqual(["base", "env"])
    expect(blocks.get("none")?.inputsIds).toEqual([])
  })

  it("captures container Template blocks", () => {
    const p = writeRunbook(`<Template id="t2" path="./tpls/bar"></Template>`)
    expect(parseTemplateBlocks(p).get("t2")?.templatePath).toBe("./tpls/bar")
  })

  it("ignores Template blocks missing id or path", () => {
    const p = writeRunbook(`
<Template path="./without-id" />
<Template id="without-path" />
`)
    expect(parseTemplateBlocks(p).size).toBe(0)
  })

  it("keeps the real block when a later fenced example reuses its id", () => {
    const p = writeRunbook(`
<Template id="vpc" path="./tpls/real" />

\`\`\`mdx
<Template id="vpc" path="./tpls/example" />
\`\`\`
`)
    expect(parseTemplateBlocks(p).get("vpc")?.templatePath).toBe("./tpls/real")
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

  it("links a block to its GoogleAuth dependency via googleAuthId", () => {
    const p = writeRunbook(`
<GoogleAuth id="gcp1" />
<Command id="cmd1" googleAuthId="gcp1">gcloud projects list</Command>
`)
    const deps = parseAuthDependencies(p)
    const d = deps.get("cmd1")
    expect(d).toBeDefined()
    expect(d!.authBlockId).toBe("gcp1")
    expect(d!.authBlockType).toBe("GoogleAuth")
  })

  it("keeps googleAuthId and awsAuthId dependencies distinct", () => {
    const p = writeRunbook(`
<AwsAuth id="aws1" />
<GoogleAuth id="gcp1" />
<Command id="aws-cmd" awsAuthId="aws1">echo aws</Command>
<Check id="gcp-check" googleAuthId="gcp1">echo gcp</Check>
`)
    const deps = parseAuthDependencies(p)
    expect(deps.get("aws-cmd")?.authBlockType).toBe("AwsAuth")
    expect(deps.get("gcp-check")?.authBlockType).toBe("GoogleAuth")
    expect(deps.get("gcp-check")?.authBlockId).toBe("gcp1")
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
      "```mdx\n" + `<Command id="cmd-in-fence" awsAuthId="aws1">echo</Command>\n` + "```\n",
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

  it("recognizes GoogleAuth as a known block type", () => {
    const p = writeRunbook(`<GoogleAuth id="gcp1" project="my-project" />`)
    const v = new InputValidator(p)
    v.init()
    expect(v.hasConfigErrors()).toBe(false)
  })

  it("parses GoogleAuth blocks into the component list", () => {
    const p = writeRunbook(`
<GoogleAuth id="gcp1" />
<Command id="cmd1" googleAuthId="gcp1">echo hi</Command>
`)
    const v = new InputValidator(p)
    v.init()
    const comp = v.getComponents().find((c) => c.type === "GoogleAuth")
    expect(comp).toBeDefined()
    expect(comp!.id).toBe("gcp1")
  })

  it("flags a GoogleAuth block with no id", () => {
    const p = writeRunbook(`<GoogleAuth project="my-project" />`)
    const v = new InputValidator(p)
    v.init()
    const err = v.getConfigErrors().find((e) => e.componentType === "GoogleAuth")
    expect(err?.componentId).toBe("(missing)")
    expect(err?.message).toContain("The 'id' prop is required")
  })

  it("ignores unknown blocks inside fenced code", () => {
    const p = writeRunbook('```mdx\n<MysteryBlock id="x" />\n```\n')
    const v = new InputValidator(p)
    v.init()
    const errs = v.getConfigErrors().filter((e) => e.componentType === "MysteryBlock")
    expect(errs).toEqual([])
  })

  it("flags Inputs missing both 'path' and inline content", () => {
    const p = writeRunbook(`<Inputs id="i1" />`)
    const v = new InputValidator(p)
    v.init()
    const err = v
      .getConfigErrors()
      .find((e) => e.componentType === "Inputs" && e.componentId === "i1")
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
    expect(errs[0]!.message).toContain("not in enum options")

    const ok = v.validateInputValues({ "i1.env": "dev" })
    expect(ok).toHaveLength(0)
  })

  // The app's Inputs block rejects these: MDX turns unfenced YAML on its own
  // lines into paragraphs and lists, with or without a wrapper element.
  it.each([
    [
      "multi-line YAML",
      '<Inputs id="i1">\nvariables:\n  - name: Region\n    type: string\n</Inputs>\n',
    ],
    [
      "YAML inside a wrapper element",
      '<Inputs id="i1">\n<div>\nvariables:\n  - name: Region\n</div>\n</Inputs>\n',
    ],
    ["one line of YAML between the tags", '<Inputs id="i1">\nvariables: []\n</Inputs>\n'],
  ])(
    "reports unfenced inline YAML (%s) as the app's code-fence config error",
    (_label, runbook) => {
      const v = new InputValidator(writeRunbook(runbook))
      v.init()
      const err = v.getConfigErrors().find((e) => e.componentId === "i1")
      expect(err?.message).toContain("Invalid inline boilerplate configuration format")
      expect(err?.message).toContain("code fence")
      expect(v.getAllSchemas().get("i1")?.variables.size).toBe(0)
    },
  )

  it("accepts inline YAML on the same line as the tags, which the app passes through as text", () => {
    const v = new InputValidator(writeRunbook('<Inputs id="i1">variables: []</Inputs>\n'))
    v.init()
    expect(v.getConfigErrors()).toEqual([])
  })

  it("accepts inline YAML in a fence with any language hint, as the app does", () => {
    const v = new InputValidator(
      writeRunbook(
        '<Inputs id="i1">\n```json\n{"variables": [{"name": "Region"}]}\n```\n</Inputs>\n',
      ),
    )
    v.init()
    expect(v.getConfigErrors()).toEqual([])
    expect([...v.getAllSchemas().get("i1")!.variables.keys()]).toEqual(["Region"])
  })

  it("lists components in document order, not grouped by type", () => {
    const p = writeRunbook(`
# Order

\`\`\`mdx
<Command id="example" command="echo example" />
\`\`\`

<Check id="check-first" command="echo first" />

<TemplateInline id="inline-tpl" outputPath="out.txt">
\`\`\`
hello
\`\`\`
</TemplateInline>

<Command id="setup" command="echo setup" />

<Template id="tpl" path="templates/tpl" />

<Check id="verify-setup" command="echo verify" />
`)
    const v = new InputValidator(p)
    v.init()
    expect(v.getComponents().map((c) => c.id)).toEqual([
      "check-first",
      "inline-tpl",
      "setup",
      "tpl",
      "verify-setup",
    ])
  })
})

// ---------------------------------------------------------------------------
// InputValidator: input values follow the Inputs form's validation rules
// ---------------------------------------------------------------------------

describe("InputValidator.validateInputValues", () => {
  function validatorFor(variablesYaml: string): InputValidator {
    const p = writeRunbook(
      `<Inputs id="i1">\n\`\`\`yaml\nvariables:\n${variablesYaml}\n\`\`\`\n</Inputs>\n`,
    )
    const v = new InputValidator(p)
    v.init()
    expect(v.getConfigErrors()).toEqual([])
    return v
  }

  it("enforces {type: regex, regex}", () => {
    const v = validatorFor(`
  - name: code
    validations:
      - type: regex
        regex: "^[A-Z]{3}$"`)
    const errs = v.validateInputValues({ "i1.code": "abc-lower" })
    expect(errs).toEqual([
      { inputKey: "i1.code", message: 'Must match pattern: ^[A-Z]{3}$ (got "abc-lower")' },
    ])
    expect(v.validateInputValues({ "i1.code": "ABC" })).toEqual([])
  })

  it("enforces {type: length, min, max} on the value's string length", () => {
    const v = validatorFor(`
  - name: short
    validations:
      - type: length
        min: 2
        max: 4
  - name: port
    type: int
    validations:
      - type: length
        min: 2
        max: 4`)
    const errs = v.validateInputValues({ "i1.short": "waytoolongvalue" })
    expect(errs).toEqual([
      {
        inputKey: "i1.short",
        message: 'Must be between 2 and 4 characters (got "waytoolongvalue")',
      },
    ])
    expect(v.validateInputValues({ "i1.short": "abc" })).toEqual([])
    // The form checks the length of "42", not the number itself.
    expect(v.validateInputValues({ "i1.port": 42 })).toEqual([])
  })

  it("enforces string shorthands such as alpha", () => {
    const v = validatorFor(`
  - name: letters
    validations:
      - alpha`)
    const errs = v.validateInputValues({ "i1.letters": "123" })
    expect(errs).toEqual([
      { inputKey: "i1.letters", message: 'Must contain only letters (got "123")' },
    ])
    expect(v.validateInputValues({ "i1.letters": "abc" })).toEqual([])
  })

  it("treats {type: required, message} as required", () => {
    const v = validatorFor(`
  - name: owner
    validations:
      - type: required
        message: Owner is required`)
    const errs = v.validateInputValues({ "i1.owner": "" })
    expect(errs).toHaveLength(1)
    expect(errs[0]!.inputKey).toBe("i1.owner")
    expect(errs[0]!.message).toContain("is required")
    expect(v.validateInputValues({ "i1.owner": "team-a" })).toEqual([])
  })

  it("rejects emails and URLs the form rejects", () => {
    const v = validatorFor(`
  - name: email
    validations:
      - email
  - name: site
    validations:
      - type: url
        message: Must be an http(s) URL`)
    // Contains "@" and "." but has no domain dot after the "@".
    expect(v.validateInputValues({ "i1.email": "first.last@localhost" })).toEqual([
      {
        inputKey: "i1.email",
        message: 'Must be a valid email address (got "first.last@localhost")',
      },
    ])
    expect(v.validateInputValues({ "i1.email": "first.last@example.com" })).toEqual([])
    // new URL() accepts any scheme; the form only accepts http(s).
    expect(v.validateInputValues({ "i1.site": "ftp://example.com" })).toEqual([
      { inputKey: "i1.site", message: 'Must be an http(s) URL (got "ftp://example.com")' },
    ])
    expect(v.validateInputValues({ "i1.site": "https://example.com" })).toEqual([])
  })

  it("leaves the value out of the message for sensitive variables", () => {
    const v = validatorFor(`
  - name: token
    sensitive: true
    validations:
      - type: length
        min: 8
        max: 64`)
    expect(v.validateInputValues({ "i1.token": "secret" })).toEqual([
      { inputKey: "i1.token", message: "Must be between 8 and 64 characters" },
    ])
  })

  it("keeps the int and bool type checks", () => {
    const v = validatorFor(`
  - name: count
    type: int
  - name: enabled
    type: bool`)
    expect(v.validateInputValues({ "i1.count": "3" })).toEqual([
      { inputKey: "i1.count", message: "Expected integer, got string" },
    ])
    expect(v.validateInputValues({ "i1.enabled": "yes" })).toEqual([
      { inputKey: "i1.enabled", message: "Expected boolean, got string" },
    ])
    expect(v.validateInputValues({ "i1.count": 3, "i1.enabled": false })).toEqual([])
  })

  it("reports malformed inline YAML as a config error", () => {
    const p = writeRunbook('<Inputs id="i1">\n```yaml\nvariables: [\n```\n</Inputs>\n')
    const v = new InputValidator(p)
    v.init()
    const err = v.getConfigErrors().find((e) => e.componentId === "i1")
    expect(err?.message).toContain("Failed to parse inline YAML")
  })
})
