import { describe, it, expect } from "bun:test"
import {
  DEFAULT_GITLAB_BASE_URL,
  normalizeGitLabBaseUrl,
  gitlabApiBase,
  parseScpRemote,
  gitHostFromRemoteUrl,
  tryGitlabBaseUrlFromRemoteUrl,
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

describe("parseScpRemote", () => {
  it("splits user@host:path, for any SSH user", () => {
    expect(parseScpRemote("git@github.com:owner/repo.git")).toEqual({
      user: "git",
      host: "github.com",
      path: "owner/repo.git",
    })
    expect(parseScpRemote("gitlab@gitlab.corp.net:group/sub/proj.git")).toEqual({
      user: "gitlab",
      host: "gitlab.corp.net",
      path: "group/sub/proj.git",
    })
  })

  it.each([
    // Option-like users and hosts: the clone URL goes into git's argv.
    "--upload-pack=touch /tmp/pwned@h:a/b",
    "-oProxyCommand=x@h:a/b",
    "git@-oProxyCommand=x:a/b",
    // Remote-helper syntax
    "ext::sh -c id@h:a/b",
    // Not SCP at all
    "https://gitlab.example.com/group/project.git",
    "ssh://git@gitlab.example.com:2222/group/project.git",
    "gitlab.example.com:group/project.git",
  ])("rejects %s", (url) => {
    expect(parseScpRemote(url)).toBeUndefined()
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
    expect(gitHostFromRemoteUrl("gitlab@gitlab.corp.net:group/project.git")).toBe(
      "gitlab.corp.net",
    )
  })

  it("does not read a host out of an option-like string", () => {
    expect(gitHostFromRemoteUrl("--upload-pack=x@h:a/b")).toBeUndefined()
  })

  it("returns undefined for empty or unparseable input", () => {
    expect(gitHostFromRemoteUrl("")).toBeUndefined()
    expect(gitHostFromRemoteUrl("   ")).toBeUndefined()
  })
})

describe("tryGitlabBaseUrlFromRemoteUrl", () => {
  it("derives a self-hosted origin from the repo's remote", () => {
    expect(tryGitlabBaseUrlFromRemoteUrl("https://gitlab.example.com/group/project.git")).toBe(
      "https://gitlab.example.com",
    )
    expect(tryGitlabBaseUrlFromRemoteUrl("git@gitlab.example.com:group/project.git")).toBe(
      "https://gitlab.example.com",
    )
    expect(tryGitlabBaseUrlFromRemoteUrl("gitlab@gitlab.corp.net:group/project.git")).toBe(
      "https://gitlab.corp.net",
    )
  })

  it("keeps an http remote's scheme and an https remote's port", () => {
    expect(tryGitlabBaseUrlFromRemoteUrl("http://gitlab.internal/group/project.git")).toBe(
      "http://gitlab.internal",
    )
    expect(tryGitlabBaseUrlFromRemoteUrl("https://gitlab.example.com:8443/group/project.git")).toBe(
      "https://gitlab.example.com:8443",
    )
  })

  it("drops credentials embedded in the remote", () => {
    expect(
      tryGitlabBaseUrlFromRemoteUrl("https://oauth2:glpat-secret@gitlab.example.com/group/project.git"),
    ).toBe("https://gitlab.example.com")
  })

  it("maps an ssh:// remote to https on the default port, not the SSH port", () => {
    expect(tryGitlabBaseUrlFromRemoteUrl("ssh://git@gitlab.example.com:2222/group/project.git")).toBe(
      "https://gitlab.example.com",
    )
    expect(tryGitlabBaseUrlFromRemoteUrl("ssh://gitlab.example.com/group/project.git")).toBe(
      "https://gitlab.example.com",
    )
  })

  it.each(["", "   ", "/srv/git/project.git", "file:///srv/git/project.git", "not a url"])(
    "returns undefined, never gitlab.com, for a remote with no host: %p",
    (url) => {
      expect(tryGitlabBaseUrlFromRemoteUrl(url)).toBeUndefined()
    },
  )
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
