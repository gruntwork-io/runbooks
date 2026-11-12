import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { folderProblem, templateFile } from "./validate.ts"

const withDir = (test: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-"))
  try {
    test(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("folderProblem", () => {
  it("refuses a folder that doesn't exist and a file", () => {
    withDir((dir) => {
      const file = path.join(dir, "main.tf")
      fs.writeFileSync(file, "")
      expect(folderProblem(path.join(dir, "nope"))?.message).toBe("doesn't exist.")
      expect(folderProblem(file)?.message).toBe("isn't a folder.")
    })
  })

  it("refuses a folder with nothing to check", () => {
    withDir((dir) => {
      fs.writeFileSync(path.join(dir, "main.tf"), "")
      expect(folderProblem(dir)?.message).toContain("nothing to check")
    })
  })

  it("accepts a module or template folder", () => {
    for (const name of [
      "runbook_block.yml",
      "simulation.yml",
      "boilerplate.yml",
      "boilerplate.yaml",
    ]) {
      withDir((dir) => {
        fs.writeFileSync(path.join(dir, name), "")
        expect(folderProblem(dir)).toBeUndefined()
      })
    }
  })
})

describe("templateFile", () => {
  it("finds a template by either name, boilerplate.yml first", () => {
    withDir((dir) => {
      expect(templateFile(dir)).toBeUndefined()
      fs.writeFileSync(path.join(dir, "boilerplate.yaml"), "")
      expect(templateFile(dir)).toBe(path.join(dir, "boilerplate.yaml"))
      fs.writeFileSync(path.join(dir, "boilerplate.yml"), "")
      expect(templateFile(dir)).toBe(path.join(dir, "boilerplate.yml"))
    })
  })
})
