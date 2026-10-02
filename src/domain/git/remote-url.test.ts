import { describe, it, expect } from "bun:test"
import { gitRemoteOwnerRepo, gitRemoteWebHost, parseGitRemoteUrl } from "./remote-url.ts"

type Parsed = NonNullable<ReturnType<typeof parseGitRemoteUrl>>

/** Remotes that parse, and the parts each must yield. */
const PARSES: Array<[string, Partial<Parsed>]> = [
  // https
  [
    "https://github.com/o/r.git",
    {
      scpLike: false,
      scheme: "https",
      hostname: "github.com",
      host: "github.com",
      path: "/o/r.git",
    },
  ],
  ["https://GitHub.com/o/r", { hostname: "github.com", host: "github.com" }],
  [
    "https://gitlab.example.com:8443/g/p.git",
    { hostname: "gitlab.example.com", port: "8443", host: "gitlab.example.com:8443" },
  ],
  ["https://github.com:443/o/r", { port: undefined, host: "github.com" }],
  [
    "https://x-access-token:secret@github.com/o/r.git",
    { user: "x-access-token", host: "github.com" },
  ],
  ["https://[::1]:8443/o/r.git", { hostname: "[::1]", port: "8443", host: "[::1]:8443" }],
  [
    "http://gitlab.local/g/sub/p.git",
    { scheme: "http", host: "gitlab.local", path: "/g/sub/p.git" },
  ],
  // ssh://
  [
    "ssh://git@host.example.com:2222/o/r.git",
    {
      scheme: "ssh",
      user: "git",
      hostname: "host.example.com",
      port: "2222",
      host: "host.example.com:2222",
      path: "/o/r.git",
    },
  ],
  [
    "ssh://git@[::1]:2222/o/r.git",
    { user: "git", hostname: "[::1]", port: "2222", host: "[::1]:2222" },
  ],
  ["ssh://Git.Example.com/o/r", { hostname: "git.example.com", user: undefined }],
  ["git://git.example.com/o/r.git", { scheme: "git", host: "git.example.com" }],
  ["file:///srv/git/o/r.git", { scheme: "file", hostname: "", host: "", path: "/srv/git/o/r.git" }],
  // scp-like
  [
    "git@github.com:o/r.git",
    {
      scpLike: true,
      scheme: "ssh",
      user: "git",
      hostname: "github.com",
      host: "github.com",
      path: "o/r.git",
    },
  ],
  [
    "deploy@gitlab.example.com:group/sub/project.git",
    { user: "deploy", host: "gitlab.example.com", path: "group/sub/project.git" },
  ],
  ["github.com:o/r", { user: undefined, host: "github.com", path: "o/r" }],
  ["git@GitHub.com:o/r", { hostname: "github.com" }],
  // A plain host's colon starts the path: 2222 is a directory, not a port.
  [
    "git@host:2222/o/r.git",
    { hostname: "host", port: undefined, host: "host", path: "2222/o/r.git" },
  ],
  ["git@host:/srv/o/r.git", { host: "host", path: "/srv/o/r.git" }],
  // IPv6 literals, normalized as URL.hostname normalizes them
  ["git@[::1]:o/r.git", { user: "git", hostname: "[::1]", host: "[::1]", path: "o/r.git" }],
  ["[::1]:o/r.git", { user: undefined, hostname: "[::1]", path: "o/r.git" }],
  ["git@[2001:DB8:0:0::1]:o/r", { hostname: "[2001:db8::1]" }],
  // git's bracketed host:port spelling
  [
    "git@[gitlab.corp:2222]:grp/proj.git",
    { hostname: "gitlab.corp", port: "2222", host: "gitlab.corp:2222", path: "grp/proj.git" },
  ],
  ["git@[gitlab.corp]:grp/proj.git", { hostname: "gitlab.corp", port: undefined }],
  // ...where the user may sit inside the brackets: git runs `ssh -p 2222 git@gitlab.corp`
  [
    "[git@gitlab.corp:2222]:platform/infra.git",
    {
      scpLike: true,
      scheme: "ssh",
      user: "git",
      hostname: "gitlab.corp",
      port: "2222",
      host: "gitlab.corp:2222",
      path: "platform/infra.git",
    },
  ],
  [
    "[git@gitlab.corp]:platform/infra.git",
    { user: "git", hostname: "gitlab.corp", port: undefined, host: "gitlab.corp" },
  ],
  [
    "[gitlab.corp:2222]:platform/infra.git",
    { user: undefined, hostname: "gitlab.corp", port: "2222" },
  ],
  ["[git@GitLab.Corp:2222]:platform/infra.git", { hostname: "gitlab.corp" }],
  ["[git@::1]:o/r.git", { user: "git", hostname: "[::1]", port: undefined, path: "o/r.git" }],
]

/** Remotes that must not parse, with the reason. */
const REJECTS: Array<[string, string]> = [
  ["", "empty"],
  ["not-a-url", "no scheme and no colon"],
  ["/srv/git/o/r.git", "local path"],
  ["./o:r", "local path with a colon after a slash"],
  ["C:/repos/o/r", "Windows drive path"],
  ["ext::sh -c touch% /tmp/pwned", "remote helper"],
  ["fd::17/foo", "remote helper"],
  // leading `-`: git or ssh would read an option
  ["-u@host:x", "leading -"],
  ["--upload-pack=touch /tmp/x:o/r", "leading -"],
  ["-oProxyCommand=evil:o/r", "leading -"],
  ["git@-oProxyCommand=evil:o/r", "host starts with -"],
  ["-oProxyCommand=evil@host:o/r", "user starts with -"],
  ["git@[-oProxyCommand=evil:22]:o/r", "bracketed host starts with -"],
  ["[git@-oProxyCommand=evil:22]:o/r", "bracketed host starts with -"],
  ["[-oProxyCommand=evil@host:22]:o/r", "bracketed user starts with -"],
  ["ssh://-oProxyCommand=evil/o/r", "URL host starts with -"],
  ["ssh://-oProxyCommand=evil@host/o/r", "URL user starts with -"],
  ["https://-evil.example.com/o/r", "URL host starts with -"],
  // `[`, `]` and `@` never belong to a plain host
  ["a@b@host:o/r", "@ inside the host"],
  ["git@ho[st:o/r", "[ inside the host"],
  ["git@host]:o/r", "] inside the host"],
  ["git@[::1:o/r", "unbalanced ["],
  ["git@[::1]x:o/r", "text after ]"],
  ["git@[::1]/o/r", "bracketed host with no path colon"],
  ["git@[gitlab.corp:99999]:o/r", "port out of range"],
  ["git@[not:an:ipv6:host]:o/r", "neither IPv6 nor host:port"],
  ["[git@gitlab.corp:2222:x]:o/r", "neither IPv6 nor host:port"],
  ["git@[git@gitlab.corp]:o/r", "a user both outside and inside the brackets"],
  ["[a@b@gitlab.corp]:o/r", "@ inside the bracketed user"],
  // IPv6 zone ids: git hands them to ssh, but no URL can carry one, so there is
  // no web host to name (see gitRemoteWebHost)
  ["git@[fe80::1%eth0]:g/p.git", "IPv6 zone id"],
  ["[git@fe80::1%eth0]:g/p.git", "IPv6 zone id"],
  ["[fe80::1%eth0]:g/p.git", "IPv6 zone id"],
  ["ssh://git@[fe80::1%25eth0]/g/p.git", "IPv6 zone id"],
  ["git@host:", "no path"],
  // characters the WHATWG parser would silently drop or rewrite
  [" git@host:o/r", "leading whitespace"],
  ["https://git\nhub.com/o/r", "newline"],
  ["https://github.com\\@evil.example/o/r", "backslash"],
  ["https://github.com /o/r", "space"],
  ["https://", "no host"],
]

describe("parseGitRemoteUrl", () => {
  it.each(PARSES)("parses %s", (raw, expected) => {
    const parsed = parseGitRemoteUrl(raw)
    expect(parsed).toBeDefined()
    // A key expected to be undefined must be absent from the result.
    const present = Object.entries(expected).filter(([, value]) => value !== undefined)
    expect(parsed).toMatchObject(Object.fromEntries(present))
    for (const [key, value] of Object.entries(expected)) {
      if (value === undefined) expect(parsed).not.toHaveProperty(key)
    }
  })

  it.each(REJECTS)("rejects %j (%s)", (raw) => {
    expect(parseGitRemoteUrl(raw)).toBeUndefined()
  })

  it("never returns the password of a URL's userinfo", () => {
    const parsed = parseGitRemoteUrl("https://user:hunter2@example.com/o/r.git")
    expect(JSON.stringify(parsed)).not.toContain("hunter2")
  })
})

describe("gitRemoteWebHost", () => {
  it.each([
    // http(s): URL.host, port included, the origin withGitHttpAuth sends a token to
    ["https://github.com/o/r.git", "github.com"],
    ["https://gitlab.example.com:8443/g/p.git", "gitlab.example.com:8443"],
    ["https://github.com:443/o/r", "github.com"],
    ["https://x-access-token:secret@github.com/o/r.git", "github.com"],
    ["https://[::1]:8443/o/r.git", "[::1]:8443"],
    ["http://gitlab.local/g/sub/p.git", "gitlab.local"],
    // ...even where parseGitRemoteUrl refuses the URL: git still pushes to it
    ["http://127.0.0.1:8080/o\\r.git", "127.0.0.1:8080"],
    ["https://ghes.corp/o/r\u00a0.git", "ghes.corp"],
    // ssh, git and scp-like: the hostname alone, since the port is not a web port
    ["ssh://git@host.example.com:2222/o/r.git", "host.example.com"],
    ["ssh://git@[::1]:2222/o/r.git", "[::1]"],
    ["git://git.example.com:9418/o/r.git", "git.example.com"],
    ["git@github.com:o/r.git", "github.com"],
    ["git@[::1]:o/r.git", "[::1]"],
    ["git@[gitlab.corp:2222]:grp/proj.git", "gitlab.corp"],
    ["[git@gitlab.corp:2222]:platform/infra.git", "gitlab.corp"],
    ["[git@::1]:o/r.git", "[::1]"],
    ["git@host:2222/o/r.git", "host"],
    // the host an https request to it reaches: an IDN name as punycode
    ["git@bücher.example:o/r.git", "xn--bcher-kva.example"],
  ])("%s → %s", (raw, host) => {
    expect(gitRemoteWebHost(raw)).toBe(host)
  })

  it.each([
    "",
    "not-a-url",
    "/srv/git/o/r.git",
    "file:///srv/git/o/r.git",
    "-u@host:o/r",
    "git@-oProxyCommand=evil:o/r",
    "ssh://-oProxyCommand=evil/o/r",
    "a@b@host:o/r",
    "git@[fe80::1%eth0]:g/p.git",
    "ssh://git@[fe80::1%25eth0]/g/p.git",
    "https://[fe80::1%25eth0]/g/p.git",
    // names the URL parser would read only part of as the host, or none of:
    // a client handed `https://ho%st` could fall back to a default instance
    "git@ho%st:g/p.git",
    "git@exa#mple.com:g/p.git",
    "git@a?b:g/p.git",
  ])("is undefined for %j", (raw) => {
    expect(gitRemoteWebHost(raw)).toBeUndefined()
  })
})

describe("gitRemoteOwnerRepo", () => {
  it.each([
    ["https://github.com/gruntwork-io/runbooks", "gruntwork-io", "runbooks"],
    ["https://github.com/gruntwork-io/runbooks.git", "gruntwork-io", "runbooks"],
    ["https://github.com/owner/repo.git/", "owner", "repo"],
    ["https://gitlab.com/group/subgroup/project.git", "group/subgroup", "project"],
    ["https://gitlab.example.com:8443/g/sub/p.git", "g/sub", "p"],
    ["ssh://git@host.example.com:2222/o/r.git", "o", "r"],
    ["git@github.com:owner/repo.git", "owner", "repo"],
    ["git@gitlab.com:group/sub/project", "group/sub", "project"],
    ["deploy@gitlab.example.com:group/project.git", "group", "project"],
    ["git@[::1]:o/r.git", "o", "r"],
    ["ssh://git@[::1]:2222/o/r.git", "o", "r"],
    ["git@[gitlab.corp:2222]:grp/sub/proj.git", "grp/sub", "proj"],
    ["[git@gitlab.corp:2222]:platform/infra.git", "platform", "infra"],
    // scp-like: the digits are a directory, so they belong to the owner
    ["git@host:2222/o/r.git", "2222/o", "r"],
  ])("%s → %s / %s", (raw, owner, repo) => {
    expect(gitRemoteOwnerRepo(raw)).toEqual({ owner, repo })
  })

  it.each([
    "https://github.com/owner",
    "git@github.com:repo.git",
    "not-a-url",
    "-u@host:o/r",
    "a@b@host:o/r",
  ])("is undefined for %s", (raw) => {
    expect(gitRemoteOwnerRepo(raw)).toBeUndefined()
  })
})
