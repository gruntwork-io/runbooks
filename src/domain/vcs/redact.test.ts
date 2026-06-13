import { describe, it, expect, afterEach } from "bun:test"
import { clearRegisteredSecrets, redactSecrets, registerSecret } from "./redact.ts"

afterEach(() => {
  clearRegisteredSecrets()
})

describe("redactSecrets — shape regexes (§8)", () => {
  it.each([
    ["ghp_" + "a".repeat(36), "classic PAT"],
    ["gho_" + "b".repeat(36), "oauth token"],
    ["ghu_" + "c".repeat(36), "user-to-server"],
    ["ghs_" + "d".repeat(36), "installation token"],
    ["ghr_" + "e".repeat(36), "refresh token"],
    ["github_pat_" + "f".repeat(60), "fine-grained PAT"],
    ["glpat-" + "g".repeat(20), "gitlab PAT"],
  ])("redacts %s (%s)", (token) => {
    const result = redactSecrets(`validation failed for token ${token} on host x`)
    expect(result).not.toContain(token)
    expect(result).toContain("[REDACTED]")
  })

  it("scrubs git URL credentials (x-access-token / oauth2)", () => {
    expect(
      redactSecrets("fatal: unable to access 'https://x-access-token:supersecret123@github.com/o/r.git/'"),
    ).toBe("fatal: unable to access 'https://[REDACTED]@github.com/o/r.git/'")
    expect(redactSecrets("cloning https://oauth2:tok_abcdef@gitlab.com/g/p.git")).toBe(
      "cloning https://[REDACTED]@gitlab.com/g/p.git",
    )
  })

  it("leaves non-secret text untouched", () => {
    const text = "authentication required for github.com/org/repo: set GITHUB_TOKEN, or run 'gh auth login'"
    expect(redactSecrets(text)).toBe(text)
  })
})

describe("redactSecrets — exact-match registry (§8)", () => {
  it("redacts GitLab's unprefixed 64-hex OAuth tokens once registered — the only safe way", () => {
    const oauthToken = "9".repeat(32) + "a".repeat(32) // 64 hex chars, no prefix
    // Unregistered: the shape regexes cannot catch it.
    expect(redactSecrets(`token=${oauthToken}`)).toContain(oauthToken)
    registerSecret(oauthToken)
    expect(redactSecrets(`token=${oauthToken}`)).toBe("token=[REDACTED]")
  })

  it("redacts every occurrence of a registered value", () => {
    registerSecret("sekret-value-123")
    expect(redactSecrets("a sekret-value-123 b sekret-value-123 c")).toBe("a [REDACTED] b [REDACTED] c")
  })

  it("ignores degenerate short values (cannot redact everything)", () => {
    registerSecret("ab")
    registerSecret(undefined)
    expect(redactSecrets("ab is fine")).toBe("ab is fine")
  })
})
