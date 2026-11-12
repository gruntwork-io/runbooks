import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { missingModule } from "./validate.ts"

describe("missingModule", () => {
  it("refuses a folder that doesn't exist and a file, and accepts a folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-"))
    try {
      const file = path.join(dir, "main.tf")
      fs.writeFileSync(file, "")
      expect(missingModule(path.join(dir, "nope"))?.message).toBe("doesn't exist.")
      expect(missingModule(file)?.message).toBe("isn't a folder.")
      expect(missingModule(dir)).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
