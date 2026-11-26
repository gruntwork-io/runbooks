import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { BlockId } from "@runbooks/blocks-core/contract"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import type { ConfigError, ConfigWarning } from "./configError.ts"
import { configErrors, type RunbookDocument } from "./document.ts"
import { parseRunbook } from "./parse.ts"

const id = Schema.decodeSync(BlockId)

const parse = (source: string, appVersion = "0.31.0") =>
  parseRunbook(source, TOY_REGISTRY, { file: "demo/runbook.mdx", appVersion })

const parsed = (source: string): RunbookDocument => {
  const result = parse(source)
  if (result._tag === "Invalid") throw new Error(result.errors.map((e) => e.message).join("\n"))
  return result.document
}

/** Every error, whether it refuses the runbook or stops one block. */
const errors = (source: string): ReadonlyArray<ConfigError> => {
  const found = configErrors(parse(source))
  if (found.length === 0) throw new Error("no errors")
  return found
}

/** Code, line and message of each error or warning, for compact assertions. */
const brief = (problems: ReadonlyArray<ConfigError | ConfigWarning>) =>
  problems.map((p) => [p.code, p.location.span.start.line, p.message] as const)

describe("parseRunbook", () => {
  it("parses blocks into nodes with decoded props, ids and lines, and the tree points at them", () => {
    const doc = parsed(
      [
        "# Deploy",
        "",
        '<Form id="config">',
        "```yaml",
        "- name: region",
        "  type: string",
        "```",
        "</Form>",
        "",
        '<Run id="create-account" command="make account" inputsId={["config"]} />',
      ].join("\n"),
    )
    expect(
      doc.blocks.map((b) => [b.index, b.tag, b.class, b.id, b.idAsWritten, b.span.start.line]),
    ).toEqual([
      [0, "Form", "form", "config", "config", 3],
      [1, "Run", "task", "create_account", "create-account", 10],
    ])
    expect(doc.blocks[0]?.props).toEqual({ variables: [{ name: "region", type: "string" }] })
    expect(doc.blocks[1]?.props).toEqual({ command: "make account" })
    expect(doc.blocks[1]?.shared).toEqual({ inputsId: [id("config")] })
    expect(doc.tree.children?.map((node) => node.type)).toEqual(["heading", "block", "block"])
    expect(doc.tree.children?.[2]).toEqual({ type: "block", index: 1, children: [] })
  })

  it("gives nested blocks indices in document order, inside their parent's children", () => {
    const doc = parsed(
      '<Note title="Outer">\n  Run this:\n\n  <Run id="inner" command="ls" />\n</Note>\n\n<Run id="after" command="pwd" />',
    )
    expect(doc.blocks.map((b) => [b.index, b.tag])).toEqual([
      [0, "Note"],
      [1, "Run"],
      [2, "Run"],
    ])
    const outer = doc.tree.children?.[0]
    expect(outer).toMatchObject({ type: "block", index: 0 })
    expect(outer?.children?.map((node) => node.type)).toEqual(["paragraph", "block"])
  })

  it("leaves a block in a code fence or inline code as text", () => {
    const doc = parsed('```mdx\n<Run command="rm -rf /" />\n```\n\nInline `<Run />` too.')
    expect(doc.blocks).toEqual([])
  })

  it("keeps HTML elements with their literal props, and literal text expressions as text", () => {
    const doc = parsed('<details open>\n<summary>More</summary>\n\nText {"and more"}\n</details>')
    const details = doc.tree.children?.[0]
    expect(details).toMatchObject({
      type: "mdxJsxFlowElement",
      name: "details",
      props: { open: true },
    })
    expect(JSON.stringify(details)).toContain('"value":"and more"')
    expect(JSON.stringify(doc.tree)).not.toContain("position")
  })

  it("reads the front matter, and keeps the file's line numbers after it", () => {
    const doc = parsed(
      '---\ntitle: Deploy\nrunbooks: ">= 0.30"\n---\n\n<Run id="a" command="ls" />',
    )
    expect(doc.frontMatter).toEqual({ title: "Deploy", runbooks: ">= 0.30" })
    expect(doc.blocks[0]?.span.start.line).toBe(6)
  })

  it("hashes the runbook's source", () => {
    const source = '<Run id="a" command="ls" />'
    const digest = `sha256:${createHash("sha256").update(source).digest("hex")}`
    expect(String(parsed(source).hash.runbook)).toBe(digest)
    expect(parsed(`${source}\n`).hash.combined).not.toBe(parsed(source).hash.combined)
  })

  describe("configuration errors", () => {
    it("reports every error in one pass, in file order, each with its line", () => {
      expect(
        brief(
          errors(
            ['<Run command="ls" />', "", '<Runn id="b" />', "", '<Run id="c" command={5} />'].join(
              "\n",
            ),
          ),
        ),
      ).toEqual([
        [
          "missingId",
          1,
          '<Run> needs an id, such as id="deploy", so other blocks and the runbook\'s tests can name it.',
        ],
        [
          "unknownBlock",
          3,
          "This runbook uses <Runn>, a block that Runbooks 0.31.0 doesn't have. If a later version of Runbooks added it, update Runbooks to use this runbook. Otherwise, check its name.",
        ],
        ["badProp", 5, "the `command` prop of <Run>: Expected string"],
      ])
    })

    it("names the block, the prop and the likely fix", () => {
      const [unknown] = errors('<Runn id="b" />')
      expect(unknown?.location).toMatchObject({
        file: "demo/runbook.mdx",
        block: { tag: "Runn" },
      })
      expect(unknown?.suggestion).toBe("<Run>")

      const [bad] = errors('<Run id="c" args="x" />')
      expect(bad?.location).toMatchObject({ block: { tag: "Run", id: "c" }, prop: "args" })
      expect(bad?.received).toBe("x")
    })

    // An id names its block's credential state folder, so it may not reach
    // outside that folder or share another block's.
    it("refuses an id, a reference or an *AuthId that is not letters, digits, `-` and `_`", () => {
      for (const written of ["../x", "x/.", "a b", "a.b"]) {
        const ids = errors(`<Run id=${JSON.stringify(written)} command="ls" />`)
        expect(ids.map((e) => [e.code, e.location.prop])).toEqual([["badProp", "id"]])
        expect(ids[0]?.message).toContain("must be letters, digits, `-` and `_`")

        const refs = errors(`<Run id="a" command="ls" dependsOn={[${JSON.stringify(written)}]} />`)
        expect(refs.map((e) => [e.code, e.location.prop])).toEqual([["badProp", "dependsOn"]])

        const aliases = errors(`<Run id="a" command="ls" awsAuthId=${JSON.stringify(written)} />`)
        expect(aliases.map((e) => [e.code, e.location.prop])).toEqual([["badProp", "awsAuthId"]])
      }
    })

    // The next two are today's src/domain/exec/blockEnv.test.ts guards, by
    // name: the parser checks the `env` prop's names, as parseBlockEnv did.
    it("refuses a name a shell can't export", () => {
      for (const name of ["1ST", "MY-VAR", "A B", "X=Y", ""]) {
        const found = errors(`<Run id="a" env={{ ${JSON.stringify(name)}: "x", OK: "y" }} />`)
        expect(found.map((e) => [e.code, e.location.prop])).toEqual([["badProp", "env"]])
        expect(found[0]?.message).toContain(`not a variable name`)
        expect(found[0]?.message).toEndWith(`(at ${name})`)
      }
    })

    it("refuses the names Runbooks sets for every run", () => {
      for (const name of [
        "RUNBOOK_OUTPUT",
        "RUNBOOK_ENV",
        "RUNBOOK_LOG",
        "RUNBOOK_ERROR_LOG",
        "GENERATED_FILES",
        "REPO_FILES",
      ]) {
        const found = errors(`<Run id="a" env={{ ${name}: "/elsewhere" }} />`)
        expect(found.map((e) => [e.code, e.location.prop])).toEqual([["badProp", "env"]])
        expect(found[0]?.message).toContain("a variable Runbooks sets for every script")
        expect(found[0]?.message).toEndWith(`(at ${name})`)
      }
      // A name that only contains a reserved one is the author's.
      expect(
        configErrors(parse('<Run id="a" env={{ MY_RUNBOOK_OUTPUT: "x", REPO_FILES_DIR: "y" }} />')),
      ).toEqual([])
    })

    it("says when a required prop is missing", () => {
      expect(brief(errors('<Clone id="g" />'))).toEqual([
        ["badProp", 1, "<Clone> needs the `url` prop."],
      ])
    })

    it("refuses a duplicate id, and names the first block's line", () => {
      const found = brief(
        errors(
          [
            '<Run id="deploy" command="a" />',
            '<Run id="deploy" command="b" />',
            '<Run id="create-account" command="c" />',
            '<Run id="create_account" command="d" />',
          ].join("\n\n"),
        ),
      )
      expect(found).toEqual([
        [
          "duplicateId",
          3,
          '<Run> on line 1 already has the id "deploy". Each block needs its own id.',
        ],
        [
          "duplicateId",
          7,
          '"create_account" is the same id as "create-account" on line 5: a hyphen and an underscore are the same in an id. Each block needs its own id.',
        ],
      ])
    })

    it("refuses a prop an alias sets itself, and applies the alias's value", () => {
      expect(brief(errors('<Bash id="b" shell="zsh" command="ls" />'))).toEqual([
        ["lockedProp", 1, "<Bash> sets `shell` itself. Remove the prop, or use <Run>."],
      ])
      const doc = parsed('<Bash id="b" command="ls" />')
      expect(doc.blocks[0]).toMatchObject({
        tag: "Bash",
        block: "Run",
        props: { shell: "bash" },
      })
    })

    it("refuses YAML children that do not parse, at their line", () => {
      const found = errors('<Form id="i">\n```yaml\n- name: [unclosed\n```\n</Form>')
      expect(found).toHaveLength(1)
      expect(found[0]?.code).toBe("badChildren")
      expect(found[0]?.location.span.start.line).toBe(3)
      expect(found[0]?.location.prop).toBe("variables")
    })

    it("refuses a value no block takes", () => {
      expect(brief(errors('<Run id="a" command={/ls/} />'))).toEqual([
        [
          "badProp",
          1,
          "the `command` prop of <Run> holds a regular expression or a bigint, which no block takes.",
        ],
      ])
    })

    it("reports MDX that does not parse, with the line", () => {
      expect(brief(errors('# Title\n\n<Run id="a" command="ls">'))).toEqual([
        ["syntax", 3, "Expected a closing tag for `<Run>` (3:1-3:26)"],
      ])
      expect(brief(errors('# T\n\n<Run a={"x} />'))).toEqual([
        ["syntax", 3, "Unterminated string constant"],
      ])
    })

    it("refuses a runbook that needs another version of Runbooks, with that error alone", () => {
      const source = '---\nrunbooks: ">= 0.40"\n---\n\n<Unknown />'
      expect(brief(errors(source))).toEqual([
        [
          "versionRequired",
          2,
          "This runbook needs Runbooks >= 0.40, and this is Runbooks 0.31.0. Update Runbooks to use it.",
        ],
      ])
    })

    it("reports a requirement it can't read, and front matter that isn't YAML", () => {
      expect(brief(errors("---\nruns: 1\nrunbooks: 0.30\n---\n"))).toEqual([
        [
          "versionRequired",
          3,
          'Quote the version of Runbooks in the front matter, as in runbooks: ">= 0.28". YAML reads an unquoted 0.30 as the number 0.3.',
        ],
      ])
      expect(errors("---\ntitle: [Deploy\n---\n")[0]).toMatchObject({ code: "syntax" })
    })
  })

  describe("which errors refuse the runbook", () => {
    it("opens a runbook whose errors are all in blocks, each on its block, and the others run", () => {
      const result = parse(
        [
          '<Run id="a" command="ls" />',
          '<Run id="b" command={5} />',
          '<Run id="a" command="pwd" />',
        ].join("\n\n"),
      )
      if (result._tag === "Invalid") throw new Error("refused")
      expect(
        result.document.blocks.map((b) => [b.idAsWritten, b.errors.map((e) => e.code)]),
      ).toEqual([
        ["a", []],
        ["b", ["badProp"]],
        ["a", ["duplicateId"]],
      ])
    })

    it("refuses a runbook with an unknown block, and reports its block errors too", () => {
      const result = parse('<Runn id="x" />\n\n<Run id="b" command={5} />')
      expect(result._tag).toBe("Invalid")
      expect(configErrors(result).map((e) => e.code)).toEqual(["unknownBlock", "badProp"])
    })
  })

  describe("warnings", () => {
    const warnings = (source: string) => brief(parsed(source).warnings)

    it("ignores a prop the block does not take, with a warning and the likely fix", () => {
      const doc = parsed('<Run id="a" command="ls" comand="pwd" />')
      expect(doc.blocks[0]?.props).toEqual({ command: "ls" })
      expect(brief(doc.warnings)).toEqual([
        ["unknownProp", 1, "<Run> has no `comand` prop, so it is ignored."],
      ])
      expect(doc.warnings[0]?.suggestion).toBe("command")
    })

    it("ignores a shared prop the block's class does not take", () => {
      expect(warnings('<Note dependsOn={["a"]} />')).toEqual([
        ["unknownProp", 1, "<Note> has no `dependsOn` prop, so it is ignored."],
      ])
    })

    it("gives a shared prop to the block as well when the block has its own", () => {
      const doc = parsed(
        '<Note title="Careful" inputsId={["config"]} />\n\n<Form id="config">\n```yaml\n[]\n```\n</Form>',
      )
      expect(doc.blocks[0]?.props).toEqual({ title: "Careful" })
      expect(doc.blocks[0]?.shared).toEqual({ title: "Careful", inputsId: [id("config")] })
    })

    it("reads an *AuthId prop as an envFrom source, with a warning", () => {
      const doc = parsed(
        '<Run id="a" command="ls" envFrom={["setup"]} awsAuthId="aws-prod" />\n\n<Run id="setup" command="make" />\n\n<GitLogin id="aws-prod" />',
      )
      expect(doc.blocks[0]?.shared.envFrom).toEqual([id("setup"), id("aws-prod")])
      expect(brief(doc.warnings)).toEqual([
        [
          "deprecatedProp",
          1,
          '`awsAuthId` still works, and `envFrom` replaces it: envFrom={["aws-prod"]} passes the same variables.',
        ],
      ])
    })

    it("warns when two credential blocks in one envFrom declare a name in common", () => {
      const doc = parsed(
        '<Run id="a" command="ls" envFrom={["one", "setup", "two"]} />\n\n<Run id="setup" command="make" />\n\n<GitLogin id="one" />\n\n<GitHubLogin id="two" />',
      )
      expect(brief(doc.warnings)).toEqual([
        [
          "envConflict",
          1,
          '`envFrom` on <Run id="a"> names <GitLogin id="one"> and <GitHubLogin id="two">, which both declare GITHUB_TOKEN, GITLAB_TOKEN. A run gets them from <GitHubLogin id="two">, the later one.',
        ],
      ])
      expect(doc.warnings[0]?.location.prop).toBe("envFrom")
    })

    it("does not warn for credential blocks whose names differ, or a task's exports, which it cannot know", () => {
      expect(
        warnings(
          '<Run id="a" command="ls" envFrom={["git", "cloud", "setup"]} />\n\n<Run id="setup" command="make" />\n\n<GitLogin id="git" />\n\n<CloudLogin id="cloud" />',
        ),
      ).toEqual([])
    })

    it("reads githubAuthId as the block's git-credential prop, with a warning", () => {
      const doc = parsed(
        '<Clone id="g" url="https://example.com/r.git" githubAuthId="gh" />\n\n<GitHubLogin id="gh" />',
      )
      expect(doc.blocks[0]?.props).toEqual({ url: "https://example.com/r.git", gitAuthId: "gh" })
      expect(doc.blocks[0]?.shared).toEqual({})
      expect(brief(doc.warnings)).toEqual([
        [
          "deprecatedProp",
          1,
          '`githubAuthId` still works, and `gitAuthId` replaces it: gitAuthId="gh" names the same block.',
        ],
      ])
      expect(doc.warnings[0]?.suggestion).toBe('gitAuthId="gh"')
    })

    it("keeps the block's own git-credential prop when githubAuthId is written too", () => {
      const doc = parsed(
        '<Clone id="g" url="https://example.com/r.git" githubAuthId="gh" gitAuthId="git" />\n\n<GitHubLogin id="gh" />\n\n<GitLogin id="git" />',
      )
      expect(doc.blocks[0]?.props).toMatchObject({ gitAuthId: "git" })
      expect(brief(doc.warnings)).toEqual([
        ["deprecatedProp", 1, "`githubAuthId` is ignored: `gitAuthId` replaces it, and is set."],
      ])
    })

    it("leaves an *AuthId prop to a block that has it as its own", () => {
      const doc = parsed(
        '<Clone id="g" url="https://example.com/r.git" gitAuthId="git-auth" />\n\n<GitLogin id="git-auth" />',
      )
      expect(doc.blocks[0]?.props).toEqual({
        url: "https://example.com/r.git",
        gitAuthId: "git_auth",
      })
      expect(doc.blocks[0]?.shared).toEqual({})
      expect(doc.warnings).toEqual([])
    })
  })
})
