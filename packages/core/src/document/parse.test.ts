import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { BlockId, defineTask, RunbookPath } from "@runbooks/blocks-core/contract"
import { MAX_VALUE_DEPTH } from "@runbooks/blocks-core/form"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import type { ConfigError, ConfigWarning } from "./configError.ts"
import { configErrors, ContentHash, type RunbookDocument } from "./document.ts"
import type { FileFact } from "./files.ts"
import { MAX_NESTING, parseMdx, splitFrontMatter } from "./mdx.ts"
import { parseRunbook } from "./parse.ts"

const id = Schema.decodeSync(BlockId)
const toPath = Schema.decodeSync(RunbookPath)
const toHash = Schema.decodeSync(ContentHash)

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

  describe("a form nested in a task", () => {
    const form = (formId: string) =>
      [
        '<Form id="' + formId + '">',
        "```yaml",
        "- name: region",
        "  type: string",
        "```",
        "</Form>",
      ].join("\n")

    it("is the last form the task reads, as an inputsId that names it would be", () => {
      const doc = parsed(
        [
          form("config"),
          "",
          '<Run id="deploy" command="ls" inputsId="config">',
          form("here"),
          "</Run>",
        ].join("\n"),
      )
      expect(doc.blocks.map((b) => [b.index, b.tag, b.id])).toEqual([
        [0, "Form", "config"],
        [1, "Run", "deploy"],
        [2, "Form", "here"],
      ])
      expect(doc.blocks[1]?.shared).toEqual({ inputsId: [id("config"), id("here")] })
      expect(
        doc.edges.filter((edge) => edge.from === 1).map((edge) => [edge.to, edge.source]),
      ).toEqual([
        [0, { _tag: "Prop", prop: "inputsId", capability: "values" }],
        [2, { _tag: "Prop", prop: "inputsId", capability: "values" }],
      ])
    })

    it("is read last even when the task's inputsId names it first, with one edge to it", () => {
      const doc = parsed(
        [
          form("config"),
          "",
          '<Run id="deploy" command="ls" inputsId={["here", "config"]}>',
          form("here"),
          "</Run>",
        ].join("\n"),
      )
      expect(doc.blocks[1]?.shared).toEqual({ inputsId: [id("config"), id("here")] })
      expect(
        doc.edges
          .filter((edge) => edge.from === 1)
          .map((edge) => edge.to)
          .sort((a, b) => a - b),
      ).toEqual([0, 2])
    })

    it("counts the first form in the task's own markdown, not one in a block nested in it", () => {
      const doc = parsed(
        [
          '<Run id="deploy" command="ls">',
          "<div>",
          form("first"),
          "</div>",
          form("second"),
          '<Note title="Inner">',
          form("in-note"),
          "</Note>",
          "</Run>",
        ].join("\n"),
      )
      expect(doc.blocks[0]?.shared).toEqual({ inputsId: [id("first")] })
    })

    it("is no form a display block reads", () => {
      const doc = parsed(['<Note title="Outer">', form("here"), "</Note>"].join("\n"))
      expect(doc.blocks[0]?.shared.inputsId).toBeUndefined()
    })

    it("says which task it is the own form of, and no other form does", () => {
      const doc = parsed(
        [
          form("config"),
          "",
          '<Run id="deploy" command="ls" inputsId="config">',
          "<div>",
          form("first"),
          "</div>",
          form("second"),
          '<Note title="Inner">',
          form("in-note"),
          "</Note>",
          "</Run>",
          "",
          '<Note title="Outer">',
          form("in-outer"),
          "</Note>",
        ].join("\n"),
      )
      expect(doc.blocks.map((b) => [b.tag, b.id, b.nestedIn])).toEqual([
        ["Form", "config", undefined],
        ["Run", "deploy", undefined],
        ["Form", "first", 1],
        ["Form", "second", undefined],
        ["Note", undefined, undefined],
        ["Form", "in_note", undefined],
        ["Note", undefined, undefined],
        ["Form", "in_outer", undefined],
      ])
      expect(doc.blocks.filter((b) => "nestedIn" in b).map((b) => b.idAsWritten)).toEqual(["first"])
    })
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
      expect(bad?.received).toBe("text")
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

    // Today's blockEnv.test.ts guard for values, by name: parseBlockEnv took
    // a number or a boolean as its text.
    it("takes a number or boolean in env as its text, as a template prints it", () => {
      const doc = parsed(
        '<Run id="a" env={{ PORT: 8080, RATIO: 0.5, DOWN: -1, DEBUG: true, QUIET: false, NAME: "x" }} />',
      )
      expect(doc.blocks[0]?.shared.env).toEqual({
        PORT: "8080",
        RATIO: "0.5",
        DOWN: "-1",
        DEBUG: "true",
        QUIET: "false",
        NAME: "x",
      })
    })

    it("refuses an env value that is not text, a number or a boolean", () => {
      for (const value of ['["a"]', '{ b: "c" }', "null"]) {
        const found = errors(`<Run id="a" env={{ OK: "y", BAD: ${value} }} />`)
        expect(found.map((e) => [e.code, e.location.prop])).toEqual([["badProp", "env"]])
        expect(found[0]?.message).toEndWith("(at BAD)")
      }
    })

    it("refuses an env value whose {{ }} Runbooks cannot fill in, naming the variable", () => {
      for (const value of [
        "{{ if .inputs.a }}y{{ end }}",
        "{{ .inputs.a | upper }}",
        '{{ eq .inputs.a "x" }}',
        "{{.Names}}",
        "x {{ .inputs.a",
      ]) {
        const found = errors(
          `<Run id="a" env={{ OK: "{{ .inputs.a }}", BAD: ${JSON.stringify(value)} }} />`,
        )
        expect(found.map((e) => [e.code, e.location.prop])).toEqual([["badProp", "env"]])
        expect(found[0]?.message).toEndWith("(at BAD)")
      }
      expect(
        configErrors(
          parse(
            '<Run id="a" env={{ A: "{{- .inputs.a -}}", B: "{{/* note */}}{{ `{{.Names}}` }}" }} />',
          ),
        ),
      ).toEqual([])
    })

    it("refuses an env value that reads an output of a block the runbook does not have", () => {
      expect(
        errors('<Run id="a" env={{ X: "{{ .outputs.nope.k }}" }} />').map((e) => [
          e.code,
          e.location.prop,
        ]),
      ).toEqual([["missingReference", "env"]])
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

    it("refuses YAML children its schema refuses with an error for each problem, at its own line", () => {
      const found = errors(
        [
          '<Form id="f">',
          "```yaml",
          "- name: a",
          "  type: nope",
          "- name: b",
          "  type: string",
          "  required: maybe",
          "```",
          "</Form>",
        ].join("\n"),
      )
      expect(found.map((e) => [e.code, e.location.span.start, e.location.prop])).toEqual([
        ["badChildren", { line: 4, column: 3 }, "variables"],
        ["badChildren", { line: 7, column: 3 }, "variables"],
      ])
      for (const error of found)
        expect(error.message).toStartWith("The YAML in <Form> isn't valid: ")
      expect(found[0]?.message).toEndWith("(at 0.type).")
      expect(found[1]?.message).toEndWith("(at 1.required).")
    })

    it("refuses YAML children that do not parse, at their line", () => {
      const found = errors('<Form id="i">\n```yaml\n- name: [unclosed\n```\n</Form>')
      expect(found).toHaveLength(1)
      expect(found[0]?.code).toBe("badChildren")
      expect(found[0]?.location.span.start.line).toBe(3)
      expect(found[0]?.location.prop).toBe("variables")
    })

    describe("a block inside a block that shows no markdown", () => {
      it("is an error on the outer block, at the inner block's line, and the runbook opens", () => {
        const doc = parsed(
          '<Clone id="c" url="https://x/y.git">\n\n<Run id="inner" command="ls" />\n\n</Clone>',
        )
        expect(doc.blocks.map((b) => b.tag)).toEqual(["Clone"])
        const [error, ...rest] = doc.blocks[0]?.errors ?? []
        expect(rest).toEqual([])
        expect(error?.code).toBe("badChildren")
        expect(error?.location.span.start).toEqual({ line: 3, column: 1 })
        expect(error?.location.block).toEqual({ tag: "Clone", id: "c" })
        expect(error?.message).toContain('<Run id="inner">')
        expect(error?.message).toContain("out of <Clone")
      })

      it("is found at any depth in YAML children, and only the outermost one", () => {
        const found = errors(
          [
            '<Form id="f">',
            "```yaml",
            "- name: region",
            "  type: string",
            "```",
            "",
            '> <Run id="deep" command="ls" />',
            "",
            "<Note>",
            "",
            '<Run id="in-note" command="ls" />',
            "",
            "</Note>",
            "</Form>",
          ].join("\n"),
        )
        expect(
          found.map((e) => [e.code, e.location.span.start.line, e.location.block?.tag]),
        ).toEqual([
          ["badChildren", 7, "Form"],
          ["badChildren", 9, "Form"],
        ])
        expect(found[1]?.message).toContain("<Note>")
      })
    })

    it("never quotes what a prop holds, which may be a secret, and says what kind of value it is", () => {
      const SECRET = "fake-secret-7f3a"
      const cases = [
        `<Run id="r" command="ls" env={{ "1BAD": "${SECRET}" }} />`,
        `<Run id="r" command="ls" env={{ A: null, B: "${SECRET}" }} />`,
        `<Run id="r" command="ls" env={{ A: "{{ printf \\"%s\\" \\"${SECRET}\\" }}" }} />`,
        `<Run id="r" command="ls" env={{ A: "x{{${SECRET}}}y" }} />`,
        `<Run id="r" command="ls" env={{ A: "{{ ${SECRET} | x }}" }} />`,
        `<Run id="r" command="ls" env="${SECRET}" />`,
        `<Run id="r" command={["${SECRET}"]} />`,
        `<Run id="r" command="ls" awsAuthId={["${SECRET}"]} />`,
        `<Run id="${SECRET} x" command="ls" />`,
        `<Run id="r" command="ls" dependsOn={["${SECRET} x"]} />`,
        `<Clone id="c" url="u" githubAuthId="${SECRET} x" />`,
      ]
      for (const source of cases) {
        const result = parse(source)
        const found = configErrors(result)
        const warned = result._tag === "Parsed" ? result.document.warnings : result.warnings
        expect(found.length).toBeGreaterThan(0)
        expect(JSON.stringify([...found, ...warned])).not.toContain(SECRET)
      }
      expect(errors(`<Run id="r" command="ls" env="${SECRET}" />`)[0]?.received).toBe("text")
      expect(errors(`<Run id="r" command={["${SECRET}"]} />`)[0]?.received).toBe("a list")
    })

    it("refuses an empty path as a bad prop of its block, and throws nothing", () => {
      expect(
        errors('<Run id="r" path="" />').map((e) => [e.code, e.location.prop, e.location.block]),
      ).toEqual([["badProp", "path", { tag: "Run", id: "r" }]])
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

    it("puts a requirement's error at its key's line, however the key is written", () => {
      for (const yaml of [
        'title: x\nrunbooks: ">= 0.40"',
        'title: x\n"runbooks": ">= 0.40"',
        "title: x\n'runbooks': \">= 0.40\"",
        '{ title: x,\n  "runbooks": ">= 0.40" }',
      ]) {
        const found = errors(`---\n${yaml}\n---\n\n# Deploy\n`)
        expect(found.map((e) => [e.code, e.location.span.start.line])).toEqual([
          ["versionRequired", 3],
        ])
      }
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

  describe("nesting", () => {
    const TOO_DEEP = `Nested more than ${MAX_NESTING} levels deep. A runbook may nest its blocks, elements, quotes and lists, and the parts inside them, at most ${MAX_NESTING} levels deep.`
    /** A runbook whose `bottom` is inside `quotes` blockquotes, on line 3. */
    const quoted = (quotes: number) => `# Deep\n\n${"> ".repeat(quotes)}bottom\n`
    /** A runbook whose `bottom` is inside `elements` divs, on line 3. */
    const inElements = (elements: number) =>
      `# Deep\n\n${"<div>".repeat(elements)}bottom${"</div>".repeat(elements)}\n`
    /** A runbook whose last item is inside `lists` lists, from line 3. */
    const listed = (lists: number) =>
      `# Deep\n\n${Array.from({ length: lists }, (_, i) => `${"  ".repeat(i)}- item`).join("\n")}\n`

    it("reads a runbook nested as deep as a runbook may be", () => {
      // The quotes, then the paragraph, then its text, MAX_NESTING levels down.
      expect(parse(quoted(MAX_NESTING - 2))._tag).toBe("Parsed")
    })

    it("refuses a runbook nested deeper, at the first part too deep, with that error alone", () => {
      const found = errors(`${quoted(MAX_NESTING - 1)}\n<Unknown />\n`)
      expect(brief(found)).toEqual([["tooDeep", 3, TOO_DEEP]])
      // The text `bottom`, after the quotes' markers.
      expect(found[0]?.location.span.start.column).toBe(2 * (MAX_NESTING - 1) + 1)
      expect(found[0]?.expected).toBe(`at most ${MAX_NESTING} levels of nesting`)
    })

    it("names the first part too deep in the runbook, when two parts are", () => {
      const twice = `${quoted(MAX_NESTING - 1)}\n${"<div>".repeat(MAX_NESTING)}later${"</div>".repeat(MAX_NESTING)}\n`
      expect(brief(errors(twice))).toEqual([["tooDeep", 3, TOO_DEEP]])
    })

    it("refuses elements and lists nested too deep", () => {
      expect(brief(errors(inElements(MAX_NESTING)))).toEqual([["tooDeep", 3, TOO_DEEP]])
      // Each list and its item are a level each.
      expect(errors(listed(MAX_NESTING / 2)).map((error) => error.code)).toEqual(["tooDeep"])
    })

    it("refuses a runbook nested deeper than the parser's own walks could go, without running out of stack", () => {
      // runbooks-reviewer on #650: Electron main ran out of stack on 500
      // nested blockquotes. Under Bun the MDX parser reads 10000 nested
      // elements, and the walks after it ran out of stack on them.
      const source = inElements(10_000)
      expect("tree" in parseMdx(splitFrontMatter(source).body)).toBe(true)
      expect(brief(errors(source))).toEqual([["tooDeep", 3, TOO_DEEP]])
    })
  })

  describe("scripts", () => {
    /** A task whose `command` prop or `path` file is its script, as Command's is. */
    const SCRIPT_REGISTRY = {
      ...TOY_REGISTRY,
      Sh: defineTask({
        ...TOY_REGISTRY.Run,
        name: "Sh",
        scripts: (p) =>
          p.command !== undefined
            ? [{ _tag: "Prop", prop: "command" }]
            : p.path !== undefined
              ? [{ _tag: "File", path: p.path }]
              : [],
      }),
    }
    const found = (text: string): FileFact => ({
      _tag: "Found",
      hash: toHash(`sha256:${createHash("sha256").update(text).digest("hex")}`),
      texts: [{ path: "scripts/use.sh", text }],
    })
    const withScripts = (source: string, script?: string) =>
      parseRunbook(
        source,
        SCRIPT_REGISTRY,
        { file: "demo/runbook.mdx", appVersion: "0.31.0" },
        new Map(script === undefined ? [] : [[toPath("scripts/use.sh"), found(script)]]),
      )
    const edgesFrom = (result: ReturnType<typeof parseRunbook>) =>
      result._tag === "Parsed" ? result.document.edges.map((edge) => edge.from) : "refused"

    it("reads no `{{ }}` in a script prop as a reference: no edge, no error", () => {
      const result = withScripts(
        [
          '<Sh id="a" command="true" outputs={["b"]} />',
          `<Sh id="gen" command='echo "{{ .outputs.a.b }}" {{ .inputs.region }}\ncat > ci.yml <<"EOF"\nrun: echo \${{ steps.a.outputs.b }} {{ .outputs.gone.k }}\nEOF' />`,
          '<Run id="old" command="{{ .outputs.a.b }}" />',
        ].join("\n\n"),
      )
      expect(configErrors(result)).toEqual([])
      // A block that does not name its scripts, the toy Run here, still reads its props' references.
      expect(edgesFrom(result)).toEqual([2])
    })

    it("reads a script block's other own props as references when its props are accepted", () => {
      const result = withScripts(
        [
          '<Sh id="a" command="true" outputs={["k"]} />',
          `<Sh id="b" shell="{{ .outputs.a.k }}" command='echo {{ .outputs.a.k }}' />`,
        ].join("\n\n"),
      )
      expect(configErrors(result)).toEqual([])
      expect(edgesFrom(result)).toEqual([1])
    })

    it("keeps each input a block's props read once, in the order written, and none a script, a title or a description reads", () => {
      const result = withScripts(
        `<Sh id="gen" title="{{ .inputs.name }}" description="{{ .inputs.note }}" shell="{{ .inputs.shell }}" env={{ A: "{{ .inputs.tags.env }}", B: "{{ .inputs.shell }}" }} command='echo {{ .inputs.region }}' />`,
      )
      expect(configErrors(result)).toEqual([])
      expect(result._tag === "Parsed" && result.document.blocks[0]!.inputs).toEqual([
        "shell",
        "tags.env",
      ])
    })

    it("reads none of a script block's own props when they are refused, only its shared ones", () => {
      const result = withScripts(
        `<Sh id="gen" outputs={5} env={{ X: "{{ .outputs.gone.k }}" }} command='echo {{ .outputs.gone.k }}' />`,
      )
      expect(configErrors(result).map((error) => [error.code, error.location.prop])).toEqual([
        ["badProp", "outputs"],
        ["missingReference", "env"],
      ])
    })

    it("reads no `{{ }}` in a script file as a reference, though the same file read by another block is", () => {
      const result = withScripts(
        [
          '<Sh id="a" command="true" outputs={["k"]} />',
          '<Sh id="b" path="scripts/use.sh" />',
          '<Run id="c" path="scripts/use.sh" />',
        ].join("\n\n"),
        '#!/usr/bin/env bash\nuse "{{ .outputs.a.k }}" {{ if .inputs.x }}\n',
      )
      expect(configErrors(result)).toEqual([])
      expect(edgesFrom(result)).toEqual([2])
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

    it("reads a block's YAML only from the fence inside it: the prop written as an attribute is ignored", () => {
      const doc = parsed(
        '<Form id="f" variables={[{ name: "attr", type: "string" }]}>\n```yaml\n- name: fenced\n  type: string\n```\n</Form>',
      )
      expect(doc.blocks[0]?.props).toEqual({ variables: [{ name: "fenced", type: "string" }] })
      expect(brief(doc.warnings)).toEqual([
        [
          "unknownProp",
          1,
          "<Form> takes its YAML only in a ```yaml code fence inside it, so the `variables` prop is ignored.",
        ],
      ])
      expect(doc.warnings[0]?.location.prop).toBe("variables")
      expect(doc.warnings[0]).not.toHaveProperty("suggestion")
      // Without a fence, it has none.
      expect(brief(errors('<Form id="f" variables={[]} />'))).toEqual([
        ["badChildren", 1, "<Form> needs its YAML, in a ```yaml code fence inside it."],
      ])
    })

    it("gives a shared prop to the block as well when the block has its own", () => {
      const doc = parsed(
        '<Note title="Careful" inputsId={["config"]} />\n\n<Form id="config">\n```yaml\n[]\n```\n</Form>',
      )
      expect(doc.blocks[0]?.props).toEqual({ title: "Careful" })
      expect(doc.blocks[0]?.shared).toEqual({ title: "Careful", inputsId: [id("config")] })
    })

    // The docs give inputsId and dependsOn as string | string[], and most
    // runbooks write inputsId="config".
    it("reads inputsId, dependsOn and envFrom written as one id as a list of it, with its reference", () => {
      const doc = parsed(
        [
          '<Run id="a" command="ls" inputsId="config" dependsOn="setup" envFrom="setup" />',
          '<Run id="setup" command="make" />',
          '<Form id="config">\n```yaml\n[]\n```\n</Form>',
        ].join("\n\n"),
      )
      expect(doc.blocks[0]?.shared).toEqual({
        inputsId: [id("config")],
        dependsOn: [id("setup")],
        envFrom: [id("setup")],
      })
      expect(doc.edges.filter((edge) => edge.from === 0).map((edge) => edge.to)).toEqual([2, 1, 1])
    })

    it("stops at YAML whose alias names a node that holds it, at the alias's line, and throws nothing", () => {
      const front = parse("---\ntitle: x\nloop: &l [*l]\n---\n\n# Hi")
      expect(front._tag).toBe("Invalid")
      expect(brief(configErrors(front))).toEqual([
        [
          "syntax",
          3,
          "The front matter isn't valid YAML: An alias names a node that holds it, so the data would hold itself.",
        ],
      ])
      const fenced = errors('<Form id="config">\n```yaml\n- name: a\n- &x [*x]\n```\n</Form>')
      expect(brief(fenced)).toEqual([
        [
          "badChildren",
          4,
          "The YAML in <Form> isn't valid: An alias names a node that holds it, so the data would hold itself.",
        ],
      ])
    })

    it("refuses a field value nested deeper than a form's values may be, at its line, and throws nothing", () => {
      const deep = (depth: number) => `${"[".repeat(depth)}"fake-secret-d33p"${"]".repeat(depth)}`
      const fenced = (depth: number) =>
        `<Form id="config">\n\`\`\`yaml\n- name: a\n  type: list\n  default: ${deep(depth)}\n\`\`\`\n</Form>`
      expect(configErrors(parse(fenced(MAX_VALUE_DEPTH)))).toEqual([])
      const found = errors(fenced(MAX_VALUE_DEPTH + 1))
      expect(brief(found)).toEqual([
        [
          "badChildren",
          5,
          `The YAML in <Form> isn't valid: Expected a value nested at most ${MAX_VALUE_DEPTH} levels deep (at 0.default).`,
        ],
      ])
      expect(found[0]?.location.prop).toBe("variables")
      expect(JSON.stringify(found)).not.toContain("fake-secret-d33p")
      // Deeper than the yaml library can read: it stops, and says why in our words.
      expect(brief(errors(fenced(8_000)))).toEqual([
        [
          "badChildren",
          5,
          "The YAML in <Form> isn't valid: its lists and maps are nested too deep to read.",
        ],
      ])
    })

    it("quotes none of the runbook's text in a YAML error, a secret beside the mistake included", () => {
      const secret = "fake-secret-yaml-41c7"
      // Any piece of the secret: the yaml library's own messages quote parts of it.
      const piece = secret.slice(0, 6)
      const fence = (yaml: string) => `<Form id="config">\n\`\`\`yaml\n${yaml}\n\`\`\`\n</Form>`
      const twice = fence(
        `- name: token\n  sensitive: true\n  default: ${secret}\n  default: again`,
      )
      expect(brief(errors(twice))).toEqual([
        ["badChildren", 6, "The YAML in <Form> isn't valid: a key appears twice in one map."],
      ])
      expect(errors(twice)[0]?.location.span.start).toEqual({ line: 6, column: 3 })
      // A fence indented in its block: the column is the file's, not the YAML's.
      const indented = `<Form id="config">\n  \`\`\`yaml\n  - name: a\n    b: 1\n    b: 2\n  \`\`\`\n</Form>`
      expect(errors(indented)[0]?.location.span.start).toEqual({ line: 5, column: 5 })
      for (const yaml of [
        // An escape YAML doesn't know: the library quotes it, and the characters after it.
        `- name: token\n  default: "\\U${secret}"`,
        // Text after a block scalar's \`|\`: the library quotes it.
        `- name: token\n  default: |${secret}\n    x`,
        // A quote that never closes.
        `- name: token\n  default: "${secret}\n- name: b`,
      ]) {
        const found = errors(fence(yaml))
        expect(found.length).toBeGreaterThan(0)
        for (const error of found) {
          expect(error.code).toBe("badChildren")
          expect(error.message).not.toContain(piece)
        }
      }
      const front = parse(`---\ntitle: x\napi_key: ${secret}\napi_key: again\n---\n\n# Hi`)
      expect(front._tag).toBe("Invalid")
      expect(brief(configErrors(front))).toEqual([
        ["syntax", 4, "The front matter isn't valid YAML: a key appears twice in one map."],
      ])
      const nested = parse("---\ntitle: x\nmeta:\n  a: 1\n  a: 2\n---\n\n# Hi")
      expect(configErrors(nested)[0]?.location.span.start).toEqual({ line: 5, column: 3 })
    })

    it("refuses a reference prop that is neither an id nor a list of them", () => {
      const found = errors('<Run id="a" command="ls" inputsId={3} />')
      expect(found.map((e) => [e.code, e.location.prop])).toEqual([["badProp", "inputsId"]])
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
