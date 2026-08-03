import { describe, it, expect, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  cleanupGoogleCredentialFiles,
  materializeCredentialFile,
  releaseCredentialFile,
} from "./google-credentials.ts"

const ADC_JSON = JSON.stringify({
  type: "authorized_user",
  client_id: "client-id.apps.googleusercontent.com",
  client_secret: "SUPER_SECRET",
  refresh_token: "1//super-secret-refresh",
})

afterEach(() => {
  // Every test's files go away even when it failed part way through.
  cleanupGoogleCredentialFiles()
})

describe("materializeCredentialFile", () => {
  it("writes the document to a private file inside the temp root", () => {
    const filePath = materializeCredentialFile(ADC_JSON)

    expect(fs.readFileSync(filePath, "utf-8")).toBe(ADC_JSON)
    expect(path.basename(filePath)).toBe("adc.json")
    // The file lives one directory below the temp root; compare through
    // realpath because macOS' /var is a symlink into /private/var.
    expect(fs.realpathSync(path.dirname(path.dirname(filePath)))).toBe(
      fs.realpathSync(os.tmpdir()),
    )
    expect(path.basename(path.dirname(filePath)).startsWith("runbooks-gcp-")).toBe(true)
  })

  it("creates the file 0600 regardless of umask", () => {
    const previousUmask = process.umask(0o000)
    try {
      const filePath = materializeCredentialFile(ADC_JSON)
      const mode = fs.statSync(filePath).mode & 0o777

      // chmod is a no-op on Windows, where the per-user temp ACL is the
      // protection instead.
      if (process.platform !== "win32") {
        expect(mode).toBe(0o600)
      }
    } finally {
      process.umask(previousUmask)
    }
  })

  it("gives each document its own directory so concurrent blocks never collide", () => {
    const first = materializeCredentialFile(ADC_JSON)
    const second = materializeCredentialFile(ADC_JSON)

    expect(second).not.toBe(first)
    expect(path.dirname(second)).not.toBe(path.dirname(first))
    expect(fs.existsSync(first)).toBe(true)
    expect(fs.existsSync(second)).toBe(true)
  })
})

describe("releaseCredentialFile", () => {
  it("removes the file and its directory", () => {
    const filePath = materializeCredentialFile(ADC_JSON)
    const dir = path.dirname(filePath)

    releaseCredentialFile(filePath)

    expect(fs.existsSync(filePath)).toBe(false)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it("leaves other materialised credentials alone", () => {
    const first = materializeCredentialFile(ADC_JSON)
    const second = materializeCredentialFile(ADC_JSON)

    releaseCredentialFile(first)

    expect(fs.existsSync(first)).toBe(false)
    expect(fs.existsSync(second)).toBe(true)
  })

  it("refuses to delete a path this process did not materialise", () => {
    // The gcloud tab hands back the user's own application_default_credentials.json.
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-gcp-test-user-"))
    const userAdc = path.join(userDir, "application_default_credentials.json")
    fs.writeFileSync(userAdc, ADC_JSON)

    try {
      releaseCredentialFile(userAdc)
      expect(fs.existsSync(userAdc)).toBe(true)
      expect(fs.readFileSync(userAdc, "utf-8")).toBe(ADC_JSON)
    } finally {
      fs.rmSync(userDir, { recursive: true, force: true })
    }
  })

  it("tolerates a file that is already gone", () => {
    const filePath = materializeCredentialFile(ADC_JSON)
    releaseCredentialFile(filePath)

    expect(() => releaseCredentialFile(filePath)).not.toThrow()
  })
})

describe("cleanupGoogleCredentialFiles", () => {
  it("removes every file materialised in this process", () => {
    const first = materializeCredentialFile(ADC_JSON)
    const second = materializeCredentialFile(ADC_JSON)

    cleanupGoogleCredentialFiles()

    expect(fs.existsSync(first)).toBe(false)
    expect(fs.existsSync(second)).toBe(false)
    expect(fs.existsSync(path.dirname(first))).toBe(false)
    expect(fs.existsSync(path.dirname(second))).toBe(false)
  })

  it("is safe to call twice, and after a manual release", () => {
    const filePath = materializeCredentialFile(ADC_JSON)
    releaseCredentialFile(filePath)

    expect(() => cleanupGoogleCredentialFiles()).not.toThrow()
    expect(() => cleanupGoogleCredentialFiles()).not.toThrow()
  })
})
