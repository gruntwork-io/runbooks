import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { missingFolder } from "./validate.ts"

describe("missingFolder", () => {
  it("refuses a folder that doesn't exist and a file, and accepts a folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-"))
    try {
      const file = path.join(dir, "main.tf")
      fs.writeFileSync(file, "")
      expect(missingFolder(path.join(dir, "nope"))?.message).toBe("doesn't exist.")
      expect(missingFolder(file)?.message).toBe("isn't a folder.")
      expect(missingFolder(dir)).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
