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

  it("leaves an attribute that opens a bracket out of any run, and heredoc bodies alone", () => {
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
      "list = [",
      "  1,",
      "]",
      "c = 4",
    )
    expect(alignAttributes(text)).toBe(
      lines(
        "a = 1",
        "tags = {",
        "  k = 1",
        "}",
        "long_name = 2",
        "script    = <<-EOT",
        "  x = 1",
        "  yy = 2",
        "  EOT",
        "b         = 3",
        "list = [",
        "  1,",
        "]",
        "c = 4",
      ),
    )
  })

  it("aligns quoted keys, and leaves a for expression's => alone", () => {
    const text = lines(
      "tags = {",
      '  "kubernetes.io/role" = "x"',
      '  Team = "ops"',
      "}",
      "upper = { for k, v in var.tags :",
      "  k => upper(v)",
      "}",
    )
    expect(alignAttributes(text)).toBe(
      lines(
        "tags = {",
        '  "kubernetes.io/role" = "x"',
        '  Team                 = "ops"',
        "}",
        "upper = { for k, v in var.tags :",
        "  k => upper(v)",
        "}",
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
    expect(["terragrunt.hcl", "main.tf", "main.tofu", "x.tfvars"].map(isHclFile)).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(["README.md", "x.tf.json"].map(isHclFile)).toEqual([false, false])
  })
})
