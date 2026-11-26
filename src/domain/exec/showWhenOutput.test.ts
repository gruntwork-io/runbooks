import { describe, it, expect } from "bun:test"
import {
  describeShowWhenOutput,
  parseShowWhenOutput,
  showWhenOutputHolds,
  type ShowWhenOutput,
} from "./showWhenOutput.ts"

const condition = (overrides: Partial<ShowWhenOutput> = {}): ShowWhenOutput => ({
  blockId: "git_auth",
  output: "GIT_PROVIDER",
  negate: false,
  values: ["gitlab"],
  whenUnknown: "show",
  ...overrides,
})

describe("parseShowWhenOutput", () => {
  it("reads equals, notEquals and in", () => {
    expect(parseShowWhenOutput({ output: "git_auth.GIT_PROVIDER", equals: "gitlab" })).toEqual({
      ok: true,
      condition: condition(),
    })
    expect(parseShowWhenOutput({ output: "git_auth.GIT_PROVIDER", notEquals: "gitlab" })).toEqual({
      ok: true,
      condition: condition({ negate: true }),
    })
    expect(
      parseShowWhenOutput({ output: "git_auth.GIT_PROVIDER", in: ["github", "gitlab"] }),
    ).toEqual({ ok: true, condition: condition({ values: ["github", "gitlab"] }) })
  })

  it("keeps the block id as written, hyphens and all", () => {
    const parsed = parseShowWhenOutput({ output: "git-auth.GIT_PROVIDER", equals: "gitlab" })
    expect(parsed).toEqual({ ok: true, condition: condition({ blockId: "git-auth" }) })
  })

  it("reads whenUnknown", () => {
    const parsed = parseShowWhenOutput({
      output: "git_auth.GIT_PROVIDER",
      equals: "gitlab",
      whenUnknown: "hide",
    })
    expect(parsed).toEqual({ ok: true, condition: condition({ whenUnknown: "hide" }) })
  })

  it.each([
    ["no output", { equals: "gitlab" }, "needs an output prop"],
    ["an output that isn't text", { output: 1, equals: "gitlab" }, "needs an output prop"],
    ["an output without a dot", { output: "git_auth", equals: "gitlab" }, "joined by a dot"],
    ["an output without a name", { output: "git_auth.", equals: "gitlab" }, "joined by a dot"],
    ["an output with two dots", { output: "a.b.c", equals: "gitlab" }, "joined by a dot"],
    ["no test", { output: "a.b" }, "exactly one of equals, notEquals or in"],
    ["two tests", { output: "a.b", equals: "x", in: ["y"] }, "not equals and in"],
    ["an equals that isn't text", { output: "a.b", equals: 1 }, "equals prop must be text"],
    ["an empty in", { output: "a.b", in: [] }, "in prop must be a list"],
    ["an in that isn't a list", { output: "a.b", in: "x" }, "in prop must be a list"],
    ["an unknown whenUnknown", { output: "a.b", equals: "x", whenUnknown: "maybe" }, "whenUnknown"],
  ])("rejects %s", (_name, props, message) => {
    const parsed = parseShowWhenOutput(props)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain(message)
  })
})

describe("showWhenOutputHolds", () => {
  it("holds while the output is one of the values", () => {
    expect(showWhenOutputHolds(condition(), "gitlab")).toBe(true)
    expect(showWhenOutputHolds(condition(), "github")).toBe(false)
    expect(showWhenOutputHolds(condition(), "GitLab")).toBe(false)
    expect(showWhenOutputHolds(condition({ values: ["github", "gitlab"] }), "github")).toBe(true)
  })

  it("holds while the output is none of the values, for notEquals", () => {
    expect(showWhenOutputHolds(condition({ negate: true }), "github")).toBe(true)
    expect(showWhenOutputHolds(condition({ negate: true }), "gitlab")).toBe(false)
  })

  it("follows whenUnknown while the output doesn't exist", () => {
    expect(showWhenOutputHolds(condition(), undefined)).toBe(true)
    expect(showWhenOutputHolds(condition({ negate: true }), undefined)).toBe(true)
    expect(showWhenOutputHolds(condition({ whenUnknown: "hide" }), undefined)).toBe(false)
  })
})

describe("describeShowWhenOutput", () => {
  it("names the output and the values", () => {
    expect(describeShowWhenOutput(condition())).toBe('git_auth.GIT_PROVIDER is "gitlab"')
    expect(describeShowWhenOutput(condition({ negate: true }))).toBe(
      'git_auth.GIT_PROVIDER is not "gitlab"',
    )
    expect(describeShowWhenOutput(condition({ values: ["a", "b", "c"] }))).toBe(
      'git_auth.GIT_PROVIDER is "a", "b" or "c"',
    )
  })
})
