import { describe, it, expect } from "vitest"
import { normalizeInstanceBaseUrl, resolveDefaultAuthMethod } from "../utils"
import { PROVIDERS } from "../providers"

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

// Which tab the block opens on. The valid set is provider-dependent — GitLab
// has no OAuth flow — so a tab the provider does not offer must fall back
// rather than render an empty pane.
describe("resolveDefaultAuthMethod", () => {
  it("defaults to the provider's own tab when no defaultTab is set", () => {
    expect(resolveDefaultAuthMethod(PROVIDERS.github, undefined)).toBe("oauth")
    expect(resolveDefaultAuthMethod(PROVIDERS.gitlab, undefined)).toBe("pat")
  })

  it("honors a tab the provider offers", () => {
    expect(resolveDefaultAuthMethod(PROVIDERS.github, "pat")).toBe("pat")
    expect(resolveDefaultAuthMethod(PROVIDERS.github, "oauth")).toBe("oauth")
    expect(resolveDefaultAuthMethod(PROVIDERS.gitlab, "pat")).toBe("pat")
  })

  it("falls back when the provider does not offer the requested tab", () => {
    // GitLab has no OAuth device flow; 'oauth' would render no form at all.
    expect(resolveDefaultAuthMethod(PROVIDERS.gitlab, "oauth")).toBe("pat")
  })

  it("falls back for an unrecognized tab name", () => {
    // MDX props are untyped, so a typo must not leave the block formless.
    expect(resolveDefaultAuthMethod(PROVIDERS.github, "token")).toBe("oauth")
    expect(resolveDefaultAuthMethod(PROVIDERS.gitlab, "")).toBe("pat")
  })
})
