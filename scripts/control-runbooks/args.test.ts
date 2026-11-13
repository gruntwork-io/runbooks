import { describe, expect, test } from "bun:test"
import { closest, COMMANDS, describeTarget, helpText, parse, UsageError } from "./args.ts"
import { nextName, slug } from "./evidence.ts"
import { ariaNodes } from "./target.ts"

const usageError = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    if (err instanceof UsageError) return err
    throw err
  }
  throw new Error("expected a UsageError")
}

describe("parse", () => {
  test("reads a role:name shorthand as the target", () => {
    const p = parse(["click", "button:Merge Pull Request", "--within", "group"])
    expect(p.target).toMatchObject({ role: "button", name: "Merge Pull Request", within: "group" })
  })

  test("keeps a fill value positional and the field in flags", () => {
    const p = parse(["fill", "platform", "--label", "Group email", "--exact"])
    expect(p.positionals).toEqual(["platform"])
    expect(p.target).toMatchObject({ label: "Group email", exact: true })
  })

  test("takes --flag=value", () => {
    expect(parse(["wait", "--text=Applied.", "--timeout=500"]).flags).toMatchObject({
      text: "Applied.",
      timeout: "500",
    })
  })

  test("suggests the closest command and flag", () => {
    expect(usageError(() => parse(["clik"])).hint).toContain("click")
    expect(usageError(() => parse(["click", "--lable", "x"])).hint).toContain("--label")
  })

  test("needs a value after a valued flag", () => {
    expect(usageError(() => parse(["click", "--role"])).message).toContain("--role needs a value")
  })

  test("refuses two ways of naming an element", () => {
    expect(usageError(() => parse(["click", "--label", "a", "--text", "b"])).message).toContain(
      "one way",
    )
  })

  test("refuses --name without --role", () => {
    expect(usageError(() => parse(["click", "--name", "Next"])).message).toContain("--role")
  })

  test("tells click a plain word isn't a target", () => {
    expect(usageError(() => parse(["click", "Next"])).hint).toContain("button:Next")
  })

  test("requires a target for click", () => {
    expect(usageError(() => parse(["click", "--within", "group"])).message).toContain(
      "needs an element",
    )
  })

  test("--nth must be a number", () => {
    expect(usageError(() => parse(["click", "tab:Code", "--nth", "first"])).message).toContain(
      "--nth",
    )
  })

  test("snapshot can scope to a block alone", () => {
    expect(parse(["snapshot", "--within", "group"]).target).toMatchObject({ within: "group" })
    expect(parse(["snapshot"]).target).toBeUndefined()
  })

  test("no command is help", () => {
    expect(parse([]).command).toBe("help")
  })
})

test("every command's help has its usage and an example", () => {
  for (const command of COMMANDS) {
    const help = helpText(command.name)
    expect(help).toContain(command.usage)
    expect(help).toContain("Example: control-runbooks")
    expect(help).toContain("--instance")
  }
})

test("describeTarget reads like the user would say it", () => {
  expect(describeTarget(parse(["click", "tab:Code", "--within", "group"]).target!)).toBe(
    'tab "Code" in group',
  )
})

test("closest ranks containing names first, then near spellings", () => {
  expect(closest("merge", ["Merge Pull Request", "Edit", "Marge"])).toEqual([
    "Merge Pull Request",
    "Marge",
  ])
  expect(closest("zzz", ["Next", "Plan"])).toEqual([])
})

test("ariaNodes reads roles and names, with escaped quotes", () => {
  expect(
    ariaNodes(
      [
        '- tablist "Module":',
        '  - tab "Code" [selected]',
        '  - button "Add \\"Sam\\""',
        "  - text: hi",
      ].join("\n"),
    ),
  ).toEqual([
    { role: "tablist", name: "Module" },
    { role: "tab", name: "Code" },
    { role: "button", name: 'Add "Sam"' },
    { role: "text", name: "" },
  ])
})

test("evidence files are numbered after the highest one there", () => {
  expect(slug('click tab "Code" in group')).toBe("click-tab-code-in-group")
  expect(nextName(["001-up.png", "007-click.png", "journal.jsonl"], "fill x", "png")).toBe(
    "008-fill-x.png",
  )
  expect(nextName([], "", "png")).toBe("001-step.png")
})
