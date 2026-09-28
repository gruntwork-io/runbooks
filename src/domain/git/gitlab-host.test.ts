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
    // Any SSH user, not just `git` (self-managed GitLab)
    expect(gitHostFromRemoteUrl("gitlab@gitlab.corp.net:group/project.git")).toBe(
      "gitlab.corp.net",
    )
  })

  it("does not read a host out of an option-like string", () => {
    expect(gitHostFromRemoteUrl("--upload-pack=x@h:a/b")).toBeUndefined()
  })

  it.each([
    ["git@[::1]:group/project.git", "[::1]"],
    ["[::1]:group/project.git", "[::1]"],
    ["gitlab.example.com:group/project.git", "gitlab.example.com"],
    // An SSH port is not the web/API port, so it is dropped
    ["git@[gitlab.corp:2222]:group/project.git", "gitlab.corp"],
    ["ssh://git@gitlab.example.com:2222/group/project.git", "gitlab.example.com"],
    ["ssh://git@gitlab.example.com/group/project.git", "gitlab.example.com"],
    // scp-like: after a plain host the colon starts the path, never a port
    ["git@gitlab.example.com:2222/group/project.git", "gitlab.example.com"],
    // An http(s) host is the one a token would be sent to, whatever the path
    ["https://gitlab.corp/group\\project.git", "gitlab.corp"],
    ["http://127.0.0.1:8080/group/project\u00a0.git", "127.0.0.1:8080"],
  ])("reads the host of %s as %s", (url, host) => {
    expect(gitHostFromRemoteUrl(url)).toBe(host)
  })

  it.each([
    "a@b@gitlab.example.com:group/project.git",
    "git@-oProxyCommand=evil:group/project.git",
    "git@gitlab[.example.com:group/project.git",
    "file:///srv/git/group/project.git",
  ])("finds no host in %s", (url) => {
    expect(gitHostFromRemoteUrl(url)).toBeUndefined()
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
    expect(gitlabBaseUrlFromRemoteUrl("git@[::1]:group/project.git")).toBe("https://[::1]")
    expect(gitlabBaseUrlFromRemoteUrl("git@[gitlab.corp:2222]:group/project.git")).toBe(
      "https://gitlab.corp",
    )
    expect(gitlabBaseUrlFromRemoteUrl("https://gitlab.corp/group\\project.git")).toBe(
      "https://gitlab.corp",
    )
    // git's bracketed spelling, user inside the brackets: `ssh -p 2222 git@gitlab.corp`
    expect(gitlabBaseUrlFromRemoteUrl("[git@gitlab.corp:2222]:platform/infra.git")).toBe(
      "https://gitlab.corp",
    )
    // The SSH port is never the API's: the API stays on the https default.
    expect(gitlabBaseUrlFromRemoteUrl("ssh://git@gitlab.example.com:2222/group/project.git")).toBe(
      "https://gitlab.example.com",
    )
    expect(gitlabBaseUrlFromRemoteUrl("ssh://gitlab.example.com/group/project.git")).toBe(
      "https://gitlab.example.com",
    )
    // Any SSH user, not just `git`
    expect(gitlabBaseUrlFromRemoteUrl("gitlab@gitlab.corp.net:group/project.git")).toBe(
      "https://gitlab.corp.net",
    )
  })

  it("keeps an https remote's port and drops credentials embedded in it", () => {
    expect(gitlabBaseUrlFromRemoteUrl("https://gitlab.example.com:8443/group/project.git")).toBe(
      "https://gitlab.example.com:8443",
    )
    expect(
      gitlabBaseUrlFromRemoteUrl("https://oauth2:glpat-secret@gitlab.example.com/group/project.git"),
    ).toBe("https://gitlab.example.com")
  })

  // A token must never go to gitlab.com just because the remote didn't say
  // where else to send it.
  it.each([
    ["no remote", ""],
    ["a local path", "/srv/git/group/project.git"],
    ["a file URL", "file:///srv/git/group/project.git"],
    ["an IPv6 zone id", "git@[fe80::1%eth0]:group/project.git"],
    ["an IPv6 zone id in a URL", "ssh://git@[fe80::1%25eth0]/group/project.git"],
    ["a host no URL can carry", "git@ho%st:group/project.git"],
    ["a host the URL parser would cut short", "git@gitlab.corp#.evil:group/project.git"],
    ["a malformed remote", "a@b@gitlab.corp:group/project.git"],
  ])("is undefined, never gitlab.com, for %s", (_, url) => {
    expect(gitlabBaseUrlFromRemoteUrl(url)).toBeUndefined()
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
