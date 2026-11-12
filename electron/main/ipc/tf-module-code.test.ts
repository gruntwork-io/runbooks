/** What a template renders with, and how Generate cleans up the files an earlier generate wrote and this one doesn't. */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mockElectron } from "../test-utils/mock-electron.ts"

mockElectron({ ipcMain: { handle: () => {} } })
const { removeStaleFiles, templateVariables } = await import("./tf-module-code.ts")

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex")

describe("templateVariables", () => {
  it("gives each input by name, all of them in Inputs, the ones the code sets as HCL, and ModuleSource", () => {
    const values = { name: "dev", role: "Admin" }
    const inputs = [
      { name: "name", kind: "string", hasDefault: false },
      { name: "role", kind: "string", hasDefault: true, default: "Admin" },
    ] as const
    expect(templateVariables(values, inputs, "git::https://example.com/m.git//x?ref=v1")).toEqual({
      name: "dev",
      role: "Admin",
      Inputs: values,
      InputsHcl: '  name = "dev"',
      ModuleSource: "git::https://example.com/m.git//x?ref=v1",
    })
  })
})

describe("removeStaleFiles", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-module-code-"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }

  it("removes a file as it was written, and the folders it leaves empty", async () => {
    write("groups/old/terragrunt.hcl", "inputs = {}\n")
    write("groups/keep.txt", "")
    const kept = await removeStaleFiles(root, [
      ["groups/old/terragrunt.hcl", sha256("inputs = {}\n")],
    ])
    expect(kept).toEqual([])
    expect(fs.existsSync(path.join(root, "groups/old"))).toBe(false)
    expect(fs.existsSync(path.join(root, "groups/keep.txt"))).toBe(true)
  })

  it("keeps a file that changed since it was written, and says so", async () => {
    write("groups/old/terragrunt.hcl", "inputs = { edited = true }\n")
    const kept = await removeStaleFiles(root, [
      ["groups/old/terragrunt.hcl", sha256("inputs = {}\n")],
    ])
    expect(kept).toEqual(["groups/old/terragrunt.hcl"])
    expect(fs.existsSync(path.join(root, "groups/old/terragrunt.hcl"))).toBe(true)
  })

  it("skips a file that's gone, and a path outside the checkout", async () => {
    write("../outside.txt", "x")
    const kept = await removeStaleFiles(root, [
      ["groups/gone/terragrunt.hcl", sha256("")],
      ["../outside.txt", sha256("x")],
    ])
    expect(kept).toEqual([])
    expect(fs.existsSync(path.join(root, "../outside.txt"))).toBe(true)
    fs.rmSync(path.join(root, "../outside.txt"))
  })
})
