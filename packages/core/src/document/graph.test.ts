import { describe, expect, it } from "bun:test"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import type { ConfigError } from "./configError.ts"
import { configErrors, type RunbookDocument } from "./document.ts"
import { parseRunbook } from "./parse.ts"

/** One block per paragraph. */
const parse = (blocks: ReadonlyArray<string>) =>
  parseRunbook(blocks.join("\n\n"), TOY_REGISTRY, {
    file: "demo/runbook.mdx",
    appVersion: "0.31.0",
  })

const parsed = (blocks: ReadonlyArray<string>): RunbookDocument => {
  const result = parse(blocks)
  if (result._tag === "Invalid") throw new Error(result.errors.map((e) => e.message).join("\n"))
  return result.document
}

const errors = (blocks: ReadonlyArray<string>): ReadonlyArray<ConfigError> => {
  const found = configErrors(parse(blocks))
  if (found.length === 0) throw new Error("no errors")
  return found
}

const brief = (found: ReadonlyArray<ConfigError>) =>
  found.map((e) => [e.code, e.location.span.start.line, e.message] as const)

/** From, to and source of each edge. */
const edges = (doc: RunbookDocument) => doc.edges.map((edge) => [edge.from, edge.to, edge.source])

const INPUTS = '<Form id="config">\n```yaml\n- name: region\n  type: string\n```\n</Form>'

describe("the reference graph", () => {
  it("makes an edge for each block a reference prop names, by index, in the order written", () => {
    const doc = parsed([
      INPUTS,
      '<GitHubLogin id="gh" />',
      '<Run id="setup" command="make" />',
      '<Run id="deploy" command="make deploy" inputsId={["config"]} dependsOn={["setup"]} envFrom={["gh", "setup"]} />',
      '<Clone id="clone" url="https://example.com/r.git" gitAuthId="gh" />',
    ])
    expect(edges(doc)).toEqual([
      [3, 0, { _tag: "Prop", prop: "inputsId", capability: "values" }],
      [3, 2, { _tag: "Prop", prop: "dependsOn", capability: "run" }],
      [3, 1, { _tag: "Prop", prop: "envFrom", capability: "env" }],
      [3, 2, { _tag: "Prop", prop: "envFrom", capability: "env" }],
      [4, 1, { _tag: "Prop", prop: "gitAuthId", capability: "git-credential" }],
    ])
    expect(doc.edges[1]).toMatchObject({ file: "demo/runbook.mdx", span: { start: { line: 12 } } })
  })

  it("makes one edge for each output a template reads, and marks the guarded ones", () => {
    const doc = parsed([
      '<Run id="build" command="make" outputs={["path", "sha"]} />',
      '<Run id="ship" command=\'cp {{ .outputs.build.path }} out {{ if hasKey .outputs.build "sha" }}{{ .outputs.build.sha }}{{ end }}\' env={{ TARGET: "{{ .outputs.build.path }}" }} />',
    ])
    expect(edges(doc)).toEqual([
      [1, 0, { _tag: "Output", key: "path", guarded: false }],
      [1, 0, { _tag: "Output", key: "sha", guarded: true }],
    ])
  })

  it("lets a display block without an id read forms", () => {
    const doc = parsed(['<Note inputsId={["config"]} />', INPUTS])
    expect(edges(doc)).toEqual([[0, 1, { _tag: "Prop", prop: "inputsId", capability: "values" }]])
  })

  it("names the prop an *AuthId edge was written as", () => {
    const doc = parsed([
      '<GitHubLogin id="gh" />',
      '<Run id="a" command="ls" githubAuthId="gh" />',
      '<Clone id="c" url="https://example.com/r.git" githubAuthId="gh" />',
    ])
    expect(edges(doc)).toEqual([
      [1, 0, { _tag: "Prop", prop: "githubAuthId", capability: "env" }],
      [2, 0, { _tag: "Prop", prop: "githubAuthId", capability: "git-credential" }],
    ])
  })

  describe("configuration errors", () => {
    it("refuses a reference to no block, with the nearest id", () => {
      const [missing] = errors([
        '<Run id="set-up" command="make" />',
        '<Run id="deploy" command="ls" dependsOn={["setup"]} />',
      ])
      expect(missing).toMatchObject({
        code: "missingReference",
        message: '`dependsOn` on <Run id="deploy"> names "setup", and no block has that id.',
        suggestion: "set-up",
        location: { block: { tag: "Run", id: "deploy" }, prop: "dependsOn" },
      })
      expect(missing?.location.span.start.line).toBe(3)
    })

    it("refuses a template that reads a block that isn't there", () => {
      expect(
        brief(
          errors([
            '<Run id="build" command="make" outputs={["path"]} />',
            '<Run id="ship" command="cp {{ .outputs.biuld.path }} out" />',
          ]),
        ),
      ).toEqual([
        [
          "missingReference",
          3,
          '`command` on <Run id="ship"> reads {{ .outputs.biuld.path }}, and no block has the id "biuld".',
        ],
      ])
    })

    it("refuses a reference to a block without the capability, and names the blocks with it", () => {
      expect(
        brief(
          errors([
            INPUTS,
            '<Run id="deploy" command="ls" dependsOn={["config"]} envFrom={["config"]} />',
            '<Clone id="c" url="https://example.com/r.git" gitAuthId="deploy" />',
          ]),
        ),
      ).toEqual([
        [
          "missingCapability",
          8,
          '`dependsOn` on <Run id="deploy"> names <Form id="config">, which doesn\'t run. Blocks that do: <Bash>, <Clone>, <Run>.',
        ],
        [
          "missingCapability",
          8,
          '`envFrom` on <Run id="deploy"> names <Form id="config">, which doesn\'t give environment variables. Blocks that do: <Bash>, <GitHubLogin>, <GitLogin>, <Run>.',
        ],
        [
          "missingCapability",
          10,
          '`gitAuthId` on <Clone id="c"> names <Run id="deploy">, which doesn\'t give a git credential. Blocks that do: <GitHubLogin>, <GitLogin>.',
        ],
      ])
    })

    it("refuses a template that reads an output the block doesn't declare", () => {
      const found = errors([
        '<Run id="build" command="make" outputs={["path"]} />',
        '<Note id="note" />',
        '<Run id="ship" command="cp {{ .outputs.build.pth }} {{ .outputs.note.text }}" />',
      ])
      expect(brief(found)).toEqual([
        [
          "undeclaredOutput",
          5,
          '`command` on <Run id="ship"> reads {{ .outputs.build.pth }}, and <Run id="build"> doesn\'t declare `pth`. It declares: path.',
        ],
        [
          "undeclaredOutput",
          5,
          '`command` on <Run id="ship"> reads {{ .outputs.note.text }}, and <Note id="note"> doesn\'t declare `text`. It declares no outputs.',
        ],
      ])
      expect(found[0]?.suggestion).toBe("path")
    })

    it("refuses a cycle once, at its first block, with the shortest loop", () => {
      expect(
        brief(
          errors([
            '<Run id="a" command="ls" outputs={["out"]} dependsOn={["b"]} />',
            '<Run id="b" command="echo {{ .outputs.c.out }}" outputs={["out"]} />',
            '<Run id="c" command="echo {{ .outputs.a.out }}" outputs={["out"]} dependsOn={["b"]} />',
          ]),
        ),
      ).toEqual([
        [
          "cycle",
          1,
          "These blocks wait for each other, so none of them can go first: a → b → c → a.",
        ],
      ])
    })

    it("refuses a block that waits for itself", () => {
      expect(brief(errors(['<Run id="a" command="ls" dependsOn={["a"]} />']))).toEqual([
        [
          "cycle",
          1,
          '`dependsOn` on <Run id="a"> names "a": that is this block. A block can\'t wait for itself.',
        ],
      ])
    })

    it("reports reference errors with the others, in one pass", () => {
      expect(
        brief(
          errors([
            '<Run command="ls" dependsOn={["nowhere"]} />',
            '<Runn id="x" />',
            '<Run id="y" command="ls" dependsOn={["x"]} />',
          ]),
        ).map(([code, line]) => [code, line]),
      ).toEqual([
        ["missingId", 1],
        ["missingReference", 1],
        ["unknownBlock", 3],
        ["missingReference", 5],
      ])
    })
  })
})
