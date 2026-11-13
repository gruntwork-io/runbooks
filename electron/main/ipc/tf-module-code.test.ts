/** What a template renders with, and how Generate replaces the files an earlier generate wrote. */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mockElectron } from "../test-utils/mock-electron.ts"

mockElectron({ ipcMain: { handle: () => {} } })
const { replaceFiles, templateVariables } = await import("./tf-module-code.ts")

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

describe("replaceFiles", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-module-code-"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  const exists = (file: string) => fs.existsSync(path.join(root, file))
  const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8")
  const replace = (folder: string, content: string, replaces: string[]) =>
    Effect.runPromise(replaceFiles(root, folder, [{ path: "terragrunt.hcl", content }], replaces))

  // The old path is the new one, as a rename that only changes letter case
  // is on a case-insensitive disk: what was there is removed before writing,
  // never after.
  it("writes the new code over a file at the same path", async () => {
    write("accounts/sandbox/terragrunt.hcl", "old\n")

    const written = await replace("accounts/sandbox", "new\n", ["accounts/sandbox/terragrunt.hcl"])

    expect(written).toEqual(["accounts/sandbox/terragrunt.hcl"])
    expect(read("accounts/sandbox/terragrunt.hcl")).toBe("new\n")
  })

  it("moves the unit when only the folder's letter case changes", async () => {
    write("accounts/Infra-catalog Sandbox/terragrunt.hcl", "old\n")

    await replace("accounts/Infra-Catalog Sandbox", "new\n", [
      "accounts/Infra-catalog Sandbox/terragrunt.hcl",
    ])

    expect(fs.readdirSync(path.join(root, "accounts"))).toEqual(["Infra-Catalog Sandbox"])
    expect(read("accounts/Infra-Catalog Sandbox/terragrunt.hcl")).toBe("new\n")
  })

  it("removes a file the user edited since, like any other it wrote", async () => {
    write("accounts/old/terragrunt.hcl", "edited by hand\n")

    await replace("accounts/new", "new\n", ["accounts/old/terragrunt.hcl"])

    expect(exists("accounts/old")).toBe(false)
  })

  it("removes a moved unit's folder with what a plan left in it, and nothing else", async () => {
    write("accounts/old/terragrunt.hcl", "old\n")
    write("accounts/old/.terraform.lock.hcl", "lock\n")
    write("accounts/old/.terragrunt-cache/abc/main.tf", "")
    write("accounts/account.hcl", "")

    await replace("accounts/new", "new\n", ["accounts/old/terragrunt.hcl"])

    expect(exists("accounts/old")).toBe(false)
    expect(exists("accounts/account.hcl")).toBe(true)
    expect(read("accounts/new/terragrunt.hcl")).toBe("new\n")
  })

  it("keeps what a plan left in a folder the new code still goes to", async () => {
    write("accounts/sandbox/terragrunt.hcl", "old\n")
    write("accounts/sandbox/.terraform.lock.hcl", "lock\n")

    await replace("accounts/sandbox", "new\n", ["accounts/sandbox/terragrunt.hcl"])

    expect(read("accounts/sandbox/.terraform.lock.hcl")).toBe("lock\n")
  })

  it("keeps a moved unit's folder that holds other files", async () => {
    write("accounts/old/terragrunt.hcl", "old\n")
    write("accounts/old/notes.md", "")

    await replace("accounts/new", "new\n", ["accounts/old/terragrunt.hcl"])

    expect(exists("accounts/old/terragrunt.hcl")).toBe(false)
    expect(exists("accounts/old/notes.md")).toBe(true)
  })

  it("skips a file that's gone, and a path outside the checkout", async () => {
    write("../outside.txt", "x")

    await replace("accounts/new", "new\n", ["accounts/gone/terragrunt.hcl", "../outside.txt"])

    expect(exists("../outside.txt")).toBe(true)
    fs.rmSync(path.join(root, "../outside.txt"))
  })
})
