import { describe, it, expect } from "bun:test"
import {
  DEFAULT_GITHUB_HOST,
  tryNormalizeGitHubHost,
  normalizeGitHubHost,
  githubHostKind,
  isGitHubDotCom,
  isGheCloudHost,
  isGitHubEnterpriseHost,
  githubWebBase,
  githubApiBase,
  githubDeviceCodeUrl,
  githubAccessTokenUrl,
  isGitHubHost,
} from "./github-host.ts"

describe("tryNormalizeGitHubHost (STRICT — never falls back to github.com)", () => {
  it("keeps a bare host", () => {
    expect(tryNormalizeGitHubHost("github.com")).toBe("github.com")
    expect(tryNormalizeGitHubHost("ghes.example.com")).toBe("ghes.example.com")
    expect(tryNormalizeGitHubHost("acme.ghe.com")).toBe("acme.ghe.com")
  })

  it("trims surrounding whitespace", () => {
    expect(tryNormalizeGitHubHost("  ghes.example.com  ")).toBe("ghes.example.com")
  })

  it("reduces a URL with a path/query/fragment to its host", () => {
    expect(tryNormalizeGitHubHost("https://ghes.example.com/org/repo")).toBe("ghes.example.com")
    expect(tryNormalizeGitHubHost("https://ghes.example.com/org/repo/tree/main?x=1#frag")).toBe(
      "ghes.example.com",
    )
    expect(tryNormalizeGitHubHost("ghes.example.com/org/repo")).toBe("ghes.example.com")
  })

  it("keeps a non-default port (bare or in a URL)", () => {
    expect(tryNormalizeGitHubHost("ghes.example.com:8443")).toBe("ghes.example.com:8443")
    expect(tryNormalizeGitHubHost("https://ghes.example.com:8443/api/v3")).toBe("ghes.example.com:8443")
  })

  it("drops the default https port", () => {
    expect(tryNormalizeGitHubHost("https://ghes.example.com:443")).toBe("ghes.example.com")
  })

  it("lowercases", () => {
    expect(tryNormalizeGitHubHost("GHES.Example.COM")).toBe("ghes.example.com")
    expect(tryNormalizeGitHubHost("HTTPS://GitHub.com/Org/Repo")).toBe("github.com")
    expect(tryNormalizeGitHubHost("Acme.GHE.com")).toBe("acme.ghe.com")
  })

  it("accepts an http:// URL but keeps only its host (GitHub is always reached over https)", () => {
    expect(tryNormalizeGitHubHost("http://ghes.internal")).toBe("ghes.internal")
    expect(tryNormalizeGitHubHost("http://ghes.internal:8080/org/repo")).toBe("ghes.internal:8080")
    // The result is a bare host, so every derived URL is https.
    expect(githubWebBase(tryNormalizeGitHubHost("http://ghes.internal")!)).toBe("https://ghes.internal")
  })

  it("rejects a non-http(s) scheme", () => {
    expect(tryNormalizeGitHubHost("ftp://ghes.example.com")).toBeUndefined()
    expect(tryNormalizeGitHubHost("ssh://git@ghes.example.com/o/r.git")).toBeUndefined()
    expect(tryNormalizeGitHubHost("file:///etc/passwd")).toBeUndefined()
  })

  it("rejects embedded credentials (userinfo)", () => {
    expect(tryNormalizeGitHubHost("https://user:pass@ghes.example.com")).toBeUndefined()
    expect(tryNormalizeGitHubHost("https://token@github.com/o/r")).toBeUndefined()
    expect(tryNormalizeGitHubHost("user@ghes.example.com")).toBeUndefined()
    // A userinfo "host" that spoofs another origin is refused, not rebound.
    expect(tryNormalizeGitHubHost("https://github.com@evil.example")).toBeUndefined()
  })

  it("returns undefined for empty/nullish/unparseable input", () => {
    expect(tryNormalizeGitHubHost(undefined)).toBeUndefined()
    expect(tryNormalizeGitHubHost(null)).toBeUndefined()
    expect(tryNormalizeGitHubHost("")).toBeUndefined()
    expect(tryNormalizeGitHubHost("   ")).toBeUndefined()
    expect(tryNormalizeGitHubHost("not a host")).toBeUndefined()
    expect(tryNormalizeGitHubHost("https://")).toBeUndefined()
    expect(tryNormalizeGitHubHost("ghes.example.com:99999")).toBeUndefined()
  })

  it("maps api.github.com back to github.com", () => {
    expect(tryNormalizeGitHubHost("api.github.com")).toBe("github.com")
    expect(tryNormalizeGitHubHost("https://api.github.com/user")).toBe("github.com")
    expect(tryNormalizeGitHubHost("API.GITHUB.COM")).toBe("github.com")
  })

  it("maps api.<sub>.ghe.com back to <sub>.ghe.com", () => {
    expect(tryNormalizeGitHubHost("api.acme.ghe.com")).toBe("acme.ghe.com")
    expect(tryNormalizeGitHubHost("https://api.acme.ghe.com/user/orgs")).toBe("acme.ghe.com")
  })

  it("leaves a GHES host starting with api. alone (GHES serves /api/v3 on the web host)", () => {
    expect(tryNormalizeGitHubHost("api.ghes.example.com")).toBe("api.ghes.example.com")
    expect(tryNormalizeGitHubHost("https://ghes.example.com/api/v3")).toBe("ghes.example.com")
  })

  // KNOWN BUG (reported): the WHATWG URL parser accepts `;`, `,`, `'`, `*`
  // etc. in a hostname, so the "strict" parse lets them through. Such a
  // host reaches the CSP string (see electron/main/csp.test.ts) and any
  // other place that trusts "strictly parsed" hosts. Marked `.failing` so
  // the suite stays green until fixed; drop `.failing` with the fix.
  it("rejects hosts with characters that are not valid in a DNS name (; , ' *)", () => {
    expect(tryNormalizeGitHubHost("ghes.example.com;script-src")).toBeUndefined()
    expect(tryNormalizeGitHubHost("a.com,b.com")).toBeUndefined()
    expect(tryNormalizeGitHubHost("a.com'self'")).toBeUndefined()
    expect(tryNormalizeGitHubHost("*.example.com")).toBeUndefined()
  })
})

describe("normalizeGitHubHost (lenient, display only)", () => {
  it("normalizes like the strict parse when it succeeds", () => {
    expect(normalizeGitHubHost("https://GHES.example.com/o/r")).toBe("ghes.example.com")
    expect(normalizeGitHubHost("api.acme.ghe.com")).toBe("acme.ghe.com")
  })

  it("falls back to github.com for empty or unparseable input", () => {
    expect(normalizeGitHubHost(undefined)).toBe(DEFAULT_GITHUB_HOST)
    expect(normalizeGitHubHost("")).toBe(DEFAULT_GITHUB_HOST)
    expect(normalizeGitHubHost("ftp://ghes.example.com")).toBe(DEFAULT_GITHUB_HOST)
    expect(normalizeGitHubHost("https://u:p@ghes.example.com")).toBe(DEFAULT_GITHUB_HOST)
  })
})

describe("host kinds", () => {
  it("classifies github.com, ghe.com tenants and GHES", () => {
    expect(githubHostKind("github.com")).toBe("dotcom")
    expect(githubHostKind("GitHub.com")).toBe("dotcom")
    expect(githubHostKind("acme.ghe.com")).toBe("ghe-cloud")
    expect(githubHostKind("my-org1.ghe.com")).toBe("ghe-cloud")
    expect(githubHostKind("ghes.example.com")).toBe("ghes")
    expect(githubHostKind("ghes.example.com:8443")).toBe("ghes")
  })

  it("does not treat look-alike names as ghe.com tenants", () => {
    // bare apex, nested sub, suffix trick, leading/trailing hyphen
    expect(githubHostKind("ghe.com")).toBe("ghes")
    expect(githubHostKind("a.b.ghe.com")).toBe("ghes")
    expect(githubHostKind("acme.ghe.com.evil.example")).toBe("ghes")
    expect(githubHostKind("-acme.ghe.com")).toBe("ghes")
    expect(githubHostKind("acme-.ghe.com")).toBe("ghes")
    expect(githubHostKind("notghe.com")).toBe("ghes")
    expect(githubHostKind("github.com.evil.example")).toBe("ghes")
  })

  it("exposes the kind predicates", () => {
    expect(isGitHubDotCom("github.com")).toBe(true)
    expect(isGitHubDotCom("acme.ghe.com")).toBe(false)
    expect(isGheCloudHost("acme.ghe.com")).toBe(true)
    expect(isGheCloudHost("ghes.example.com")).toBe(false)
    expect(isGitHubEnterpriseHost("github.com")).toBe(false)
    expect(isGitHubEnterpriseHost("acme.ghe.com")).toBe(true)
    expect(isGitHubEnterpriseHost("ghes.example.com")).toBe(true)
  })
})

describe("URL builders", () => {
  it("githubApiBase per host kind", () => {
    expect(githubApiBase("github.com")).toBe("https://api.github.com")
    expect(githubApiBase("acme.ghe.com")).toBe("https://api.acme.ghe.com")
    expect(githubApiBase("ghes.example.com")).toBe("https://ghes.example.com/api/v3")
    expect(githubApiBase("ghes.example.com:8443")).toBe("https://ghes.example.com:8443/api/v3")
  })

  it("githubWebBase is the https origin", () => {
    expect(githubWebBase("github.com")).toBe("https://github.com")
    expect(githubWebBase("acme.ghe.com")).toBe("https://acme.ghe.com")
    expect(githubWebBase("ghes.example.com:8443")).toBe("https://ghes.example.com:8443")
  })

  it("device-flow endpoints live on the web origin for every kind", () => {
    expect(githubDeviceCodeUrl("github.com")).toBe("https://github.com/login/device/code")
    expect(githubAccessTokenUrl("github.com")).toBe("https://github.com/login/oauth/access_token")
    expect(githubDeviceCodeUrl("acme.ghe.com")).toBe("https://acme.ghe.com/login/device/code")
    expect(githubAccessTokenUrl("acme.ghe.com")).toBe("https://acme.ghe.com/login/oauth/access_token")
    expect(githubDeviceCodeUrl("ghes.example.com:8443")).toBe(
      "https://ghes.example.com:8443/login/device/code",
    )
    expect(githubAccessTokenUrl("ghes.example.com")).toBe(
      "https://ghes.example.com/login/oauth/access_token",
    )
  })
})

describe("isGitHubHost (provider detection)", () => {
  it("recognizes github.com and ghe.com tenants by name", () => {
    expect(isGitHubHost("github.com")).toBe(true)
    expect(isGitHubHost("GitHub.com")).toBe(true)
    expect(isGitHubHost("api.github.com")).toBe(true)
    expect(isGitHubHost("acme.ghe.com")).toBe(true)
    expect(isGitHubHost("https://acme.ghe.com/o/r")).toBe(true)
  })

  it("recognizes an arbitrary (GHES) host only when it is a known host", () => {
    expect(isGitHubHost("ghes.example.com")).toBe(false)
    expect(isGitHubHost("ghes.example.com", [])).toBe(false)
    expect(isGitHubHost("ghes.example.com", ["other.example.com"])).toBe(false)
    expect(isGitHubHost("ghes.example.com", ["ghes.example.com"])).toBe(true)
    // known hosts are normalized too (case, URL form)
    expect(isGitHubHost("GHES.example.com", ["https://ghes.example.com/"])).toBe(true)
    // the port is part of the identity
    expect(isGitHubHost("ghes.example.com:8443", ["ghes.example.com"])).toBe(false)
    expect(isGitHubHost("ghes.example.com:8443", ["ghes.example.com:8443"])).toBe(true)
  })

  it("accepts any iterable of known hosts", () => {
    expect(isGitHubHost("ghes.example.com", new Set(["ghes.example.com"]))).toBe(true)
  })

  it("never classifies GitLab or unknown hosts as GitHub by name", () => {
    expect(isGitHubHost("gitlab.com")).toBe(false)
    expect(isGitHubHost("gitlab.example.com")).toBe(false)
    expect(isGitHubHost("bitbucket.org")).toBe(false)
  })

  it("is false for unparseable input even if listed", () => {
    expect(isGitHubHost("")).toBe(false)
    expect(isGitHubHost("ftp://ghes.example.com", ["ghes.example.com"])).toBe(false)
    expect(isGitHubHost("https://u:p@ghes.example.com", ["ghes.example.com"])).toBe(false)
  })
})
