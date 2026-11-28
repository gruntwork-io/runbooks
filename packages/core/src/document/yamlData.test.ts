import { describe, expect, it } from "bun:test"
import { Result } from "effect"
import YAML from "yaml"
import { parseYaml, yamlData } from "./yamlData.ts"

const read = (text: string) => yamlData(YAML.parseDocument(text))

/** Nine aliases to the node before, six times over: 9^6 copies of `x`. */
const ALIAS_BOMB = [
  "a: &a [x, x, x, x, x, x, x, x, x]",
  ...["b", "c", "d", "e", "f", "g"].map(
    (name, i) => `${name}: &${name} [${Array(9).fill(`*${"abcdefg"[i]}`).join(", ")}]`,
  ),
].join("\n")

describe("the data a YAML document holds", () => {
  it("repeats a node an alias names", () => {
    expect(read("a: &a [1, 2]\nb: *a")).toEqual(Result.succeed({ a: [1, 2], b: [1, 2] }))
  })

  it("is refused when an alias names a node that holds it, at the alias", () => {
    for (const text of ["- &x [*x]", "top: 1\na: &m\n  b: *m"]) {
      const result = read(text)
      expect(Result.isFailure(result) && result.failure.message).toContain("would hold itself")
      expect(Result.isFailure(result) && text.slice(result.failure.offset)).toStartWith("*")
    }
  })

  it("points at the alias that holds itself, not an earlier harmless one", () => {
    const text = "defaults: &d\n  region: us-east-1\nprod: *d\nloop: &x\n  - *x\n"
    const result = read(text)
    expect(
      Result.isFailure(result) && text.slice(0, result.failure.offset).split("\n"),
    ).toHaveLength(5)
    expect(Result.isFailure(result) && text.slice(result.failure.offset)).toStartWith("*x")
  })

  it("is refused when aliases repeat a node so often that it would grow too large", () => {
    const result = read(ALIAS_BOMB)
    expect(Result.isFailure(result) && result.failure.message).toContain("too large to read")
  })

  it("gives any other failure to read the data as it is, not as too many aliases", () => {
    const doc = YAML.parseDocument("a: &a 1\nb: *a")
    doc.toJS = () => {
      throw new Error("Unresolved tag")
    }
    expect(yamlData(doc)).toEqual(
      Result.fail({ message: "It could not be read: Unresolved tag", offset: 0 }),
    )
  })

  it("returns a result, never throwing, for data nested 20,000 deep", () => {
    const depth = 20_000
    const result = read(`${"[".repeat(depth)}${"]".repeat(depth)}`)
    expect(Result.isSuccess(result) || result.failure.offset === 0).toBe(true)
  })
})

describe("YAML that does not parse", () => {
  it("says its lists and maps nest too deep, at where the library stopped, for flow and block YAML", () => {
    const depth = 8_000
    const flow = `a: ${"[".repeat(depth)}x${"]".repeat(depth)}`
    const block = Array.from({ length: depth }, (_, level) => `${"  ".repeat(level)}k:`).join("\n")
    for (const text of [flow, `${block} x`]) {
      const { problems } = parseYaml(text)
      expect(problems.length).toBeGreaterThan(0)
      expect(problems.map((problem) => problem.reason)).toEqual(
        problems.map(() => "its lists and maps are nested too deep to read"),
      )
      expect(problems[0]?.line).toBeGreaterThan(0)
    }
  })
})
