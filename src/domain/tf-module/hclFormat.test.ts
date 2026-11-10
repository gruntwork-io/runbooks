import { describe, it, expect } from "bun:test"
import { alignAttributes, isHclFile } from "./hclFormat.ts"

const lines = (...l: string[]) => l.join("\n")

describe("alignAttributes", () => {
  it("lines up the = of consecutive attributes at one indentation", () => {
    expect(
      alignAttributes(
        lines(
          "inputs = {",
          '  id = "team@example.com"',
          '  display_name = "Team"',
          '  owners = ["a@example.com"]',
          "}",
        ),
      ),
    ).toBe(
      lines(
        "inputs = {",
        '  id           = "team@example.com"',
        '  display_name = "Team"',
        '  owners       = ["a@example.com"]',
        "}",
      ),
    )
  })

  it("starts a new run after a blank line, a comment, a block or another indentation", () => {
    const text = lines(
      "locals {",
      "  # Why.",
      '  a = "1"',
      "  bbb = 2",
      "",
      "  cc = 3",
      "  nested {",
      "    dddd = 4",
      "  }",
      "  e = 5",
      "}",
    )
    expect(alignAttributes(text)).toBe(
      lines(
        "locals {",
        "  # Why.",
        '  a   = "1"',
        "  bbb = 2",
        "",
        "  cc = 3",
        "  nested {",
        "    dddd = 4",
        "  }",
        "  e = 5",
        "}",
      ),
    )
  })

  it("ends a run with an attribute whose value goes on, and leaves heredocs alone", () => {
    const text = lines(
      "a = 1",
      "tags = {",
      "  k = 1",
      "}",
      "long_name = 2",
      "script = <<-EOT",
      "  x = 1",
      "  yy = 2",
      "  EOT",
      "b = 3",
    )
    expect(alignAttributes(text)).toBe(
      lines(
        "a    = 1",
        "tags = {",
        "  k = 1",
        "}",
        "long_name = 2",
        "script    = <<-EOT",
        "  x = 1",
        "  yy = 2",
        "  EOT",
        "b = 3",
      ),
    )
  })

  it("leaves aligned text and comparisons as they are", () => {
    const text = lines("a  = 1", "bb = 2", "c = a == b")
    expect(alignAttributes(text)).toBe(lines("a  = 1", "bb = 2", "c  = a == b"))
    expect(alignAttributes(alignAttributes(text))).toBe(alignAttributes(text))
  })
})

describe("isHclFile", () => {
  it("knows HCL's native-syntax files", () => {
    expect(["terragrunt.hcl", "main.tf", "x.tfvars"].map(isHclFile)).toEqual([true, true, true])
    expect(["README.md", "x.tf.json"].map(isHclFile)).toEqual([false, false])
  })
})
