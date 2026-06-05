import { describe, it, expect } from "vitest"
import { normalizeInstanceBaseUrl } from "../utils"

// Mirrors the backend's normalizeGitLabBaseUrl (src/domain/git/gitlab-host.ts),
// but returns null (rather than the gitlab.com default) so the PAT form can fall
// back to the provider's static create-token link.
describe("normalizeInstanceBaseUrl", () => {
  it("returns null for empty / whitespace / nullish input", () => {
    expect(normalizeInstanceBaseUrl(undefined)).toBeNull()
    expect(normalizeInstanceBaseUrl(null)).toBeNull()
    expect(normalizeInstanceBaseUrl("")).toBeNull()
    expect(normalizeInstanceBaseUrl("   ")).toBeNull()
  })

  it("keeps a full https origin and drops path/query/trailing slash", () => {
    expect(normalizeInstanceBaseUrl("https://gitlab.acme.com")).toBe("https://gitlab.acme.com")
    expect(normalizeInstanceBaseUrl("https://gitlab.acme.com/")).toBe("https://gitlab.acme.com")
    expect(normalizeInstanceBaseUrl("https://gitlab.acme.com/-/foo?x=1")).toBe("https://gitlab.acme.com")
  })

  it("assumes https when the scheme is missing and preserves a port", () => {
    expect(normalizeInstanceBaseUrl("gitlab.acme.com")).toBe("https://gitlab.acme.com")
    expect(normalizeInstanceBaseUrl("gitlab.acme.com:8443")).toBe("https://gitlab.acme.com:8443")
  })

  it("preserves an explicit http scheme", () => {
    expect(normalizeInstanceBaseUrl("http://gitlab.internal")).toBe("http://gitlab.internal")
  })

  it("returns null for a non-http(s) scheme rather than mangling it", () => {
    // Guards the `https://ftp` foot-gun from naive scheme-prefixing.
    expect(normalizeInstanceBaseUrl("ftp://gitlab.acme.com")).toBeNull()
  })
})
