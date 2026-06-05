import { describe, it, expect } from "bun:test"
import {
  DEFAULT_GITLAB_BASE_URL,
  normalizeGitLabBaseUrl,
  gitlabApiBase,
  hostToBaseUrl,
  gitHostFromRemoteUrl,
  gitlabBaseUrlFromRemoteUrl,
  isGitLabHost,
} from "./gitlab-host.ts"

describe("normalizeGitLabBaseUrl", () => {
  it("defaults to gitlab.com for empty/nullish input", () => {
    expect(normalizeGitLabBaseUrl(undefined)).toBe(DEFAULT_GITLAB_BASE_URL)
    expect(normalizeGitLabBaseUrl(null)).toBe(DEFAULT_GITLAB_BASE_URL)
    expect(normalizeGitLabBaseUrl("")).toBe(DEFAULT_GITLAB_BASE_URL)
    expect(normalizeGitLabBaseUrl("   ")).toBe(DEFAULT_GITLAB_BASE_URL)
  })

  it("keeps a full https URL's origin and drops path/query/trailing slash", () => {
    expect(normalizeGitLabBaseUrl("https://gitlab.example.com")).toBe("https://gitlab.example.com")
    expect(normalizeGitLabBaseUrl("https://gitlab.example.com/")).toBe("https://gitlab.example.com")
    expect(normalizeGitLabBaseUrl("https://gitlab.example.com/api/v4")).toBe("https://gitlab.example.com")
    expect(normalizeGitLabBaseUrl("https://gitlab.example.com:8443/foo?x=1")).toBe(
      "https://gitlab.example.com:8443",
    )
  })

  it("assumes https when the scheme is missing", () => {
    expect(normalizeGitLabBaseUrl("gitlab.example.com")).toBe("https://gitlab.example.com")
    expect(normalizeGitLabBaseUrl("gitlab.example.com:8443")).toBe("https://gitlab.example.com:8443")
  })

  it("preserves an explicit http scheme", () => {
    expect(normalizeGitLabBaseUrl("http://gitlab.internal")).toBe("http://gitlab.internal")
  })

  it("falls back to gitlab.com for a non-http(s) or unparseable scheme", () => {
    expect(normalizeGitLabBaseUrl("ftp://gitlab.example.com")).toBe(DEFAULT_GITLAB_BASE_URL)
  })
})

describe("gitlabApiBase", () => {
  it("appends /api/v4 and tolerates a trailing slash", () => {
    expect(gitlabApiBase("https://gitlab.com")).toBe("https://gitlab.com/api/v4")
    expect(gitlabApiBase("https://gitlab.example.com/")).toBe("https://gitlab.example.com/api/v4")
  })
})

describe("hostToBaseUrl", () => {
  it("wraps a host in an https origin", () => {
    expect(hostToBaseUrl("gitlab.example.com")).toBe("https://gitlab.example.com")
  })
})

describe("gitHostFromRemoteUrl", () => {
  it("reads the host from an HTTPS remote (incl. port)", () => {
    expect(gitHostFromRemoteUrl("https://gitlab.example.com/group/project.git")).toBe(
      "gitlab.example.com",
    )
    expect(gitHostFromRemoteUrl("https://gitlab.example.com:8443/group/project.git")).toBe(
      "gitlab.example.com:8443",
    )
  })

  it("reads the host from an SSH/SCP remote", () => {
    expect(gitHostFromRemoteUrl("git@gitlab.example.com:group/project.git")).toBe(
      "gitlab.example.com",
    )
  })

  it("returns undefined for empty or unparseable input", () => {
    expect(gitHostFromRemoteUrl("")).toBeUndefined()
    expect(gitHostFromRemoteUrl("   ")).toBeUndefined()
  })
})

describe("gitlabBaseUrlFromRemoteUrl", () => {
  it("derives a self-hosted origin from the repo's remote", () => {
    expect(gitlabBaseUrlFromRemoteUrl("https://gitlab.example.com/group/project.git")).toBe(
      "https://gitlab.example.com",
    )
    expect(gitlabBaseUrlFromRemoteUrl("git@gitlab.example.com:group/project.git")).toBe(
      "https://gitlab.example.com",
    )
  })

  it("falls back to gitlab.com when the host can't be determined", () => {
    expect(gitlabBaseUrlFromRemoteUrl("")).toBe(DEFAULT_GITLAB_BASE_URL)
  })
})

describe("isGitLabHost", () => {
  it("matches gitlab.com and self-hosted hosts carrying a gitlab label", () => {
    expect(isGitLabHost("gitlab.com")).toBe(true)
    expect(isGitLabHost("gitlab.example.com")).toBe(true)
    expect(isGitLabHost("gitlab-ce.corp.net")).toBe(true)
    expect(isGitLabHost("code.gitlab.internal")).toBe(true)
    expect(isGitLabHost("GitLab.Example.COM")).toBe(true)
  })

  it("does not match unrelated hosts", () => {
    expect(isGitLabHost("github.com")).toBe(false)
    expect(isGitLabHost("bitbucket.org")).toBe(false)
    expect(isGitLabHost("git.corp.net")).toBe(false)
    expect(isGitLabHost("mygitlabby.com")).toBe(false)
  })
})
