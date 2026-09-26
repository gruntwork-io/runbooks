import { describe, it, expect } from "bun:test"
import { buildContentSecurityPolicy, githubImageOrigins } from "./csp.ts"

/** The img-src directive's source list. */
const imgSrc = (policy: string): string[] => {
  const directive = policy
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("img-src "))
  return directive ? directive.split(/\s+/).slice(1) : []
}

/** Directive names in order. */
const directives = (policy: string): string[] =>
  policy
    .split(";")
    .map((d) => d.trim().split(/\s+/)[0])
    .filter(Boolean)

const BASE_DIRECTIVES = ["default-src", "script-src", "style-src", "img-src", "media-src", "font-src"]

describe("buildContentSecurityPolicy", () => {
  it("with no hosts: the static policy (github.com + every ghe.com tenant + gitlab.com + gravatar)", () => {
    const policy = buildContentSecurityPolicy()
    expect(directives(policy)).toEqual(BASE_DIRECTIVES)
    expect(imgSrc(policy)).toEqual([
      "'self'",
      "data:",
      "runbook-asset:",
      "https://avatars.githubusercontent.com",
      "https://*.ghe.com",
      "https://gitlab.com",
      "https://secure.gravatar.com",
    ])
    expect(policy).toContain("script-src 'self' 'unsafe-eval'")
  })

  it("a GHES host adds https://<host> and https://avatars.<host>", () => {
    const sources = imgSrc(buildContentSecurityPolicy(["ghes.example.com"]))
    expect(sources).toContain("https://ghes.example.com")
    expect(sources).toContain("https://avatars.ghes.example.com")
  })

  it("normalizes GHES hosts (case, URL form, port) and dedupes", () => {
    const origins = githubImageOrigins([
      "GHES.example.com",
      "https://ghes.example.com/org/repo",
      "ghes.example.com",
      "ghes2.example.com:8443",
    ])
    expect(origins).toEqual([
      "https://ghes.example.com",
      "https://avatars.ghes.example.com",
      "https://ghes2.example.com:8443",
      "https://avatars.ghes2.example.com:8443",
    ])
  })

  it("github.com and ghe.com tenants add nothing (covered by the static entries)", () => {
    expect(githubImageOrigins(["github.com", "api.github.com", "acme.ghe.com", "api.acme.ghe.com"])).toEqual([])
    expect(buildContentSecurityPolicy(["github.com", "acme.ghe.com"])).toBe(buildContentSecurityPolicy())
  })

  it("junk hosts with spaces or other schemes/userinfo never reach the policy", () => {
    const junk = [
      "evil.example.com *",
      "ghes.example.com; script-src *",
      "x 'unsafe-inline'",
      "ftp://ghes.example.com",
      "https://u:p@ghes.example.com",
      "",
      "   ",
    ]
    expect(githubImageOrigins(junk)).toEqual([])
    expect(buildContentSecurityPolicy(junk)).toBe(buildContentSecurityPolicy())
  })

  // KNOWN BUG (reported): tryNormalizeGitHubHost accepts `;` in a hostname
  // (WHATWG URL allows it), so a host like `ghes.example.com;connect-src`
  // (no spaces) — e.g. from GH_HOST, hosts.yml or a renderer-supplied
  // github:host-picked value persisted as lastSelectedGitHubHost — injects
  // extra CSP directives. Drop `.failing` once the strict parse (or
  // githubImageOrigins) rejects non-DNS characters.
  it("a host containing ';' or ',' or quotes never reaches the policy", () => {
    const junk = ["ghes.example.com;connect-src", "a.com,b.com", "a.com'unsafe-inline'"]
    expect(githubImageOrigins(junk)).toEqual([])
    const policy = buildContentSecurityPolicy(junk)
    expect(directives(policy)).toEqual(BASE_DIRECTIVES)
  })
})
