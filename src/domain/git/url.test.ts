import { describe, it, expect } from "bun:test"
import { injectTokenIntoUrl } from "./url.ts"

describe("injectTokenIntoUrl", () => {
  const TOKEN = "ghp_TESTTOKEN1234567890"

  it("injects token into an HTTPS GitHub URL", () => {
    const result = injectTokenIntoUrl(
      "https://github.com/owner/repo.git",
      TOKEN,
    )
    expect(result).toBe(
      `https://x-access-token:${TOKEN}@github.com/owner/repo.git`,
    )
  })

  it("injects token into an HTTPS GitLab URL", () => {
    // The helper does not differentiate hosts — every HTTPS URL is rewritten
    // with the GitHub-style `x-access-token` username. Documented here so a
    // future host-aware change is a deliberate decision, not an accident.
    const result = injectTokenIntoUrl(
      "https://gitlab.com/group/project.git",
      TOKEN,
    )
    expect(result).toBe(
      `https://x-access-token:${TOKEN}@gitlab.com/group/project.git`,
    )
  })

  it("preserves the path, including subgroups and .git suffix", () => {
    const result = injectTokenIntoUrl(
      "https://gitlab.com/group/sub/project.git",
      TOKEN,
    )
    expect(result).toBe(
      `https://x-access-token:${TOKEN}@gitlab.com/group/sub/project.git`,
    )
  })

  it("returns an SSH URL unchanged (no place for userinfo)", () => {
    const ssh = "git@github.com:owner/repo.git"
    expect(injectTokenIntoUrl(ssh, TOKEN)).toBe(ssh)
  })

  it("returns an empty string unchanged", () => {
    expect(injectTokenIntoUrl("", TOKEN)).toBe("")
  })

  it("returns a malformed URL unchanged", () => {
    expect(injectTokenIntoUrl("not a url", TOKEN)).toBe("not a url")
  })

  it("overwrites — never appends — pre-existing userinfo", () => {
    const result = injectTokenIntoUrl(
      "https://olduser:oldpass@github.com/owner/repo.git",
      TOKEN,
    )
    expect(result).toBe(
      `https://x-access-token:${TOKEN}@github.com/owner/repo.git`,
    )
    expect(result).not.toContain("olduser")
    expect(result).not.toContain("oldpass")
    // Belt-and-braces regression check: never end up with two userinfo blocks.
    expect((result.match(/@/g) || []).length).toBe(1)
  })

  it("does not leak the token outside the returned URL", () => {
    // For each input variant, capture anything the function writes to
    // console.error or throws as a stringified Error. None of those
    // surfaces should ever include the token.
    const originalError = console.error
    const originalWarn = console.warn
    const captured: string[] = []
    console.error = (...args: unknown[]) => captured.push(args.join(" "))
    console.warn = (...args: unknown[]) => captured.push(args.join(" "))
    try {
      const inputs = [
        "https://github.com/owner/repo.git",
        "git@github.com:owner/repo.git",
        "",
        "not a url",
        "https://user:pass@github.com/owner/repo.git",
      ]
      for (const input of inputs) {
        let threw: unknown
        let returned: string | undefined
        try {
          returned = injectTokenIntoUrl(input, TOKEN)
        } catch (e) {
          threw = e
        }
        // The thrown / logged surface must never contain the token.
        if (threw) {
          expect(String(threw)).not.toContain(TOKEN)
        }
        // The token is allowed to appear *only* inside the returned URL,
        // and even then only when the URL was parseable.
        if (returned !== undefined && returned === input) {
          expect(returned).not.toContain(TOKEN)
        }
      }
      for (const line of captured) {
        expect(line).not.toContain(TOKEN)
      }
    } finally {
      console.error = originalError
      console.warn = originalWarn
    }
  })
})
