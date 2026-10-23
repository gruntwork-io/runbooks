import { describe, it, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { exportLines, parseBlockEnv, sameBlockEnv, shellQuote } from "./blockEnv.ts"

describe("parseBlockEnv", () => {
  it("gives a block without an env prop no variables", () => {
    expect(parseBlockEnv(undefined)).toEqual({ ok: true, env: {} })
  })

  it("keeps each value's template as written, and a number or boolean as its text", () => {
    expect(
      parseBlockEnv({
        BUCKET: "{{ .inputs.BucketName }}",
        _private: "x",
        COUNT: 3,
        DRY_RUN: false,
      }),
    ).toEqual({
      ok: true,
      env: { BUCKET: "{{ .inputs.BucketName }}", _private: "x", COUNT: "3", DRY_RUN: "false" },
    })
  })

  it("refuses an env prop that isn't an object of names and values", () => {
    for (const value of ["BUCKET=x", ["BUCKET"], null, 3]) {
      const parsed = parseBlockEnv(value)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toContain("must be an object")
    }
  })

  it("refuses a name a shell can't export", () => {
    for (const name of ["1ST", "MY-VAR", "A B", "X=Y", ""]) {
      const parsed = parseBlockEnv({ [name]: "x" })
      expect(parsed).toEqual({
        ok: false,
        error: `"${name}" in env is not a variable name. Use letters, digits and underscores, and don't start with a digit.`,
      })
    }
  })

  it("refuses the names Runbooks sets for every run", () => {
    for (const name of [
      "RUNBOOK_OUTPUT",
      "RUNBOOK_LOG",
      "RUNBOOK_ERROR_LOG",
      "GENERATED_FILES",
      "REPO_FILES",
    ]) {
      const parsed = parseBlockEnv({ [name]: "/elsewhere" })
      expect(parsed).toEqual({
        ok: false,
        error: `${name} in env is a variable Runbooks sets for every script. Pick another name.`,
      })
    }
  })

  it("refuses a value that is a list, an object or null", () => {
    for (const value of [["a"], { a: "b" }, null]) {
      expect(parseBlockEnv({ TAGS: value })).toEqual({
        ok: false,
        error: "TAGS in env must be a string, number or boolean.",
      })
    }
  })
})

describe("sameBlockEnv", () => {
  it("compares names and templates, not their order", () => {
    expect(sameBlockEnv({ A: "1", B: "2" }, { B: "2", A: "1" })).toBe(true)
    expect(sameBlockEnv({ A: "1" }, { A: "2" })).toBe(false)
    expect(sameBlockEnv({ A: "1" }, { A: "1", B: "2" })).toBe(false)
    expect(sameBlockEnv({}, {})).toBe(true)
  })
})

describe("exportLines", () => {
  // Values that would run code if a shell parsed them, as a block output
  // taken from a PR title or an API response can be.
  const PAYLOADS = [
    "Fix typo $(touch /tmp/runbooks-pwned)",
    "`touch /tmp/runbooks-pwned`",
    "it's done'; touch /tmp/runbooks-pwned; echo '",
    '"; touch /tmp/runbooks-pwned; echo "',
    "line one\nline two",
    "",
  ]

  it("quotes each value so a shell sets it exactly, running nothing", () => {
    for (const value of PAYLOADS) {
      const script = `${exportLines({ VALUE: value })}\nprintf '%s' "$VALUE"`
      const proc = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      })
      expect(proc.status).toBe(0)
      expect(proc.stdout).toBe(value)
    }
  })

  it("writes one export per variable, in order", () => {
    expect(exportLines({ A: "1", B: "it's" })).toBe("export A='1'\nexport B='it'\\''s'")
    expect(shellQuote("")).toBe("''")
  })
})
