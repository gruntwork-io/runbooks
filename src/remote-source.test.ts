import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import {
  isRemoteSource,
  parseRemoteSource,
  redactSourceCredentials,
  resolveRef,
} from "./remote-source.ts"
import { makeTestSpawner } from "./test-utils/TestSpawner.ts"

function parse(url: string) {
  return Effect.runSync(parseRemoteSource(url))
}

function parseError(url: string): string {
  const result = Effect.runSync(Effect.either(parseRemoteSource(url)))
  if (result._tag === "Right") throw new Error(`expected ${url} to be rejected`)
  return result.left.message
}

describe("isRemoteSource", () => {
  it.each([
    "https://github.com/owner/repo/tree/main/path",
    "https://gitlab.com/owner/repo/-/tree/main/path",
    "http://github.com/owner/repo",
    "HTTPS://github.com/owner/repo",
    "git::https://github.com/owner/repo.git//path?ref=v1.0",
    "git::ssh://git@github.com/owner/repo.git//path",
    "ssh://git@github.com/owner/repo.git",
    "git@github.com:owner/repo.git//path?ref=main",
    "github.com/owner/repo//path",
    "github.com/owner/repo/path",
    "gitlab.com/owner/repo//path",
    "  https://github.com/owner/repo  ",
  ])("treats %s as remote", (input) => {
    expect(isRemoteSource(input)).toBe(true)
  })

  it.each([
    "./path/to/runbook.mdx",
    "/absolute/path/to/runbook.mdx",
    "relative/path",
    "runbook.mdx",
    "C:\\runbooks\\setup",
    "github.com.backup/runbook.mdx",
    // git would read it as an option (`-u` is clone's --upload-pack)
    "-u@host:repo",
  ])("treats %s as a local path", (input) => {
    expect(isRemoteSource(input)).toBe(false)
  })
})

// Credential-bearing URLs are assembled at runtime so the source holds no
// `user:password@host` literal for secret scanners to flag.
const PASSWORD = ["hunter", "22"].join("")
const withUserinfo = (scheme: string, userinfo: string, rest: string) =>
  `${scheme}://${userinfo}@${rest}`
// A stand-in for go-getter's `?sshkey=`, a base64 private key.
const SSH_KEY = ["c3NoLWtl", "eQ+/ZmFrZQ=="].join("")

describe("redactSourceCredentials", () => {
  it.each([
    [
      withUserinfo("https", `user:${PASSWORD}`, "github.com/o/r/tree/main/x"),
      "https://github.com/o/r/tree/main/x",
    ],
    // A token can pose as the username, so an http(s) userinfo goes entirely.
    [withUserinfo("https", "ghp_" + "a".repeat(36), "github.com/o/r"), "https://github.com/o/r"],
    [
      withUserinfo("git::https", `u:${PASSWORD}`, "git.example.com/o/r.git//x?ref=main"),
      "git::https://git.example.com/o/r.git//x?ref=main",
    ],
    [
      withUserinfo("git::ssh", `git:${PASSWORD}`, "github.com/o/r.git//x"),
      "git::ssh://git@github.com/o/r.git//x",
    ],
    [
      withUserinfo("ssh", `deploy:${PASSWORD}`, "host:2222/o/r.git"),
      "ssh://deploy@host:2222/o/r.git",
    ],
    // The URL parser ends the userinfo at the last `@` before the path.
    [
      withUserinfo("https", `user:p@${PASSWORD}`, "github.com/o/r/tree/main/x"),
      "https://github.com/o/r/tree/main/x",
    ],
    [
      withUserinfo("git::https", `u:p@${PASSWORD}`, "git.example.com/o/r.git//x"),
      "git::https://git.example.com/o/r.git//x",
    ],
    [withUserinfo("ssh", `git:p@${PASSWORD}`, "host/o/r.git"), "ssh://git@host/o/r.git"],
    // A `?` or `#` before the path leaves no repository, so it can't hide one.
    [
      withUserinfo("https", `user:p#${PASSWORD}`, "git.example.com/o/r"),
      "https://git.example.com/o/r",
    ],
    [
      withUserinfo("https", `user:p?${PASSWORD}`, "git.example.com/o/r"),
      "https://git.example.com/o/r",
    ],
    // Transports parseRemoteSource rejects still reach its error's url field.
    [withUserinfo("ftp", `user:${PASSWORD}`, "host/o/r"), "ftp://host/o/r"],
    [withUserinfo("git::ftp", `user:${PASSWORD}`, "host/o/r"), "git::ftp://host/o/r"],
    [withUserinfo("git+https", `user:${PASSWORD}`, "host/o/r"), "git+https://host/o/r"],
    [withUserinfo("git::git+https", `user:${PASSWORD}`, "host/o/r"), "git::git+https://host/o/r"],
    // http(s) may drop or double its `//`: the URL parser reads userinfo either way.
    [
      `git::https:/user:${PASSWORD}@git.example.com/o/r.git//x`,
      "git::https:/git.example.com/o/r.git//x",
    ],
    [
      `git::https:user:${PASSWORD}@git.example.com/o/r.git//x`,
      "git::https:git.example.com/o/r.git//x",
    ],
    [
      `git::https:\\\\user:${PASSWORD}@git.example.com/o/r.git//x`,
      "git::https:\\\\git.example.com/o/r.git//x",
    ],
    // Scheme-less credentials, as git's own URLs spell them.
    [`user:${PASSWORD}@github.com/o/r`, "github.com/o/r"],
    [`git::oauth2:p@${PASSWORD}@gitlab.com/g/p.git//x`, "git::gitlab.com/g/p.git//x"],
    [`${PASSWORD}@github.com/o/r`, "github.com/o/r"],
    // Typos: one `/` after another scheme; a tab the URL parser drops.
    [`git::ssh:/git:${PASSWORD}@host/o/r.git`, "git::ssh:/git@host/o/r.git"],
    [`git+https:/user:${PASSWORD}@host/o/r`, "git+https:/host/o/r"],
    [
      `git::ht\ttps://user:${PASSWORD}@git.example.com/o/r.git//x`,
      "git::https://git.example.com/o/r.git//x",
    ],
  ])("%s → %s", (input, expected) => {
    expect(redactSourceCredentials(input)).toBe(expected)
  })

  it.each([
    "https://github.com/o/r/tree/main/x",
    "ssh://git@github.com/o/r.git",
    "git@github.com:o/r.git//x?ref=main",
    "git::git@github.com:o/r.git//x?ref=main",
    "github.com/o/r//x?ref=main",
    "https://github.com/o/r/tree/main/a@b",
  ])("leaves %s alone", (input) => {
    expect(redactSourceCredentials(input)).toBe(input)
  })

  it("keeps the `\\@` of an https URL, whose host ends at the `\\`", () => {
    // Taking `evil.example\` for userinfo would show a github.com source
    // for a clone of evil.example.
    const source = "https://evil.example\\@github.com/o/tree/main/x"
    expect(parse(source).host).toBe("evil.example")
    expect(redactSourceCredentials(source)).toBe(source)
  })

  it("drops tabs and newlines as the URL parser does: a git:: source with one still opens", () => {
    const source = withUserinfo("git::ht\ttps", `user:${PASSWORD}`, "git.example.com/o/r.git//x")
    expect(parse(source).cloneURL).toBe("https://git.example.com/o/r.git")
    expect(redactSourceCredentials(source)).toBe("git::https://git.example.com/o/r.git//x")
  })

  it.each([
    [
      `git::ssh://git@host/o/r.git//x?ref=main&sshkey=${SSH_KEY}`,
      "git::ssh://git@host/o/r.git//x?ref=main&sshkey=[REDACTED]",
    ],
    [`git@host:o/r.git?sshkey=${SSH_KEY}&ref=main`, "git@host:o/r.git?sshkey=[REDACTED]&ref=main"],
    [`github.com/o/r//x?sshkey=${SSH_KEY}#readme`, "github.com/o/r//x?sshkey=[REDACTED]#readme"],
    // go-getter decodes the parameter's name.
    [
      `git::ssh://git@host/o/r.git?ssh%6Bey=${SSH_KEY}`,
      "git::ssh://git@host/o/r.git?ssh%6Bey=[REDACTED]",
    ],
    [
      withUserinfo("git::ssh", `git:${PASSWORD}`, `host/o/r.git?sshkey=${SSH_KEY}`),
      "git::ssh://git@host/o/r.git?sshkey=[REDACTED]",
    ],
  ])("redacts go-getter's sshkey (a private key): %s", (input, expected) => {
    expect(redactSourceCredentials(input)).toBe(expected)
  })

  it("leaves the other query parameters alone", () => {
    expect(redactSourceCredentials("github.com/o/r//x?ref=main&depth=1")).toBe(
      "github.com/o/r//x?ref=main&depth=1",
    )
  })
})

describe("parseRemoteSource", () => {
  describe("GitHub browser URLs", () => {
    it("tree URL: ref and path stay joined until resolveRef", () => {
      expect(parse("https://github.com/owner/repo/tree/main/path/to/dir")).toEqual({
        host: "github.com",
        owner: "owner",
        repo: "repo",
        cloneURL: "https://github.com/owner/repo.git",
        ref: undefined,
        path: undefined,
        refAndPath: "main/path/to/dir",
      })
    })

    it("blob URL to runbook.mdx", () => {
      const result = parse("https://github.com/owner/repo/blob/main/path/to/runbook.mdx")
      expect(result.refAndPath).toBe("main/path/to/runbook.mdx")
      expect(result.ref).toBeUndefined()
      expect(result.path).toBeUndefined()
    })

    it("ignores query strings, fragments and a trailing slash", () => {
      for (const url of [
        "https://github.com/owner/repo/tree/main/runbooks/vpc/",
        "https://github.com/owner/repo/tree/main/runbooks/vpc?tab=readme-ov-file",
        "https://github.com/owner/repo/tree/main/runbooks/vpc#readme",
      ]) {
        expect(parse(url).refAndPath).toBe("main/runbooks/vpc")
      }
      expect(
        parse("https://github.com/owner/repo/blob/main/runbooks/vpc/runbook.mdx?plain=1#L10")
          .refAndPath,
      ).toBe("main/runbooks/vpc/runbook.mdx")
    })

    it("decodes percent-escapes in the path", () => {
      expect(parse("https://github.com/owner/repo/tree/main/my%20runbooks/vpc").refAndPath).toBe(
        "main/my runbooks/vpc",
      )
    })

    it("a tree URL for a branch (no path)", () => {
      expect(parse("https://github.com/owner/repo/tree/release/v1").refAndPath).toBe("release/v1")
    })

    it("accepts a browser URL pasted without https://", () => {
      const result = parse("github.com/owner/repo/tree/main/runbooks/vpc")
      expect(result.refAndPath).toBe("main/runbooks/vpc")
      expect(result.cloneURL).toBe("https://github.com/owner/repo.git")
    })
  })

  describe("GitLab browser URLs", () => {
    it("tree URL", () => {
      const result = parse("https://gitlab.com/owner/repo/-/tree/main/path")
      expect(result.host).toBe("gitlab.com")
      expect(result.owner).toBe("owner")
      expect(result.repo).toBe("repo")
      expect(result.refAndPath).toBe("main/path")
    })

    it("drops GitLab's ?ref_type=heads", () => {
      expect(
        parse("https://gitlab.com/owner/repo/-/tree/main/runbooks/vpc?ref_type=heads").refAndPath,
      ).toBe("main/runbooks/vpc")
      expect(
        parse("https://gitlab.com/owner/repo/-/blob/v1.0/runbooks/vpc/runbook.mdx?ref_type=tags")
          .refAndPath,
      ).toBe("v1.0/runbooks/vpc/runbook.mdx")
    })

    it("tree URL with nested groups (full group path as owner)", () => {
      const result = parse("https://gitlab.com/group/subgroup/project/-/tree/main/path/to/dir")
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
      expect(result.refAndPath).toBe("main/path/to/dir")
      expect(result.cloneURL).toBe("https://gitlab.com/group/subgroup/project.git")
    })

    it("blob URL with nested groups", () => {
      const result = parse("https://gitlab.com/group/subgroup/project/-/blob/main/file.ts")
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
      expect(result.refAndPath).toBe("main/file.ts")
    })

    it("tree URL on a self-hosted GitLab instance", () => {
      const result = parse("https://gitlab.example.com/group/subgroup/project/-/tree/main/path")
      expect(result.host).toBe("gitlab.example.com")
      expect(result.owner).toBe("group/subgroup")
      expect(result.cloneURL).toBe("https://gitlab.example.com/group/subgroup/project.git")
    })

    it("accepts a browser URL pasted without https://", () => {
      const result = parse("gitlab.com/group/project/-/tree/main/runbooks/vpc")
      expect(result.owner).toBe("group")
      expect(result.refAndPath).toBe("main/runbooks/vpc")
    })

    it.each([
      "https://gitlab.com/group/project/-/raw/main/runbooks/vpc/runbook.mdx",
      "https://gitlab.example.com/group/sub/project/-/commits/main",
      "gitlab.com/group/project/-/raw/main/runbooks/vpc",
      "gitlab.com/group/project/-/commits/main//runbooks/vpc",
    ])(
      "rejects a GitLab page other than tree/blob instead of reading it as nested groups: %s",
      (url) => {
        // `-` is reserved by GitLab: no group or project path can be `-`.
        expect(parseError(url)).toContain("unsupported URL format")
      },
    )
  })

  describe("plain repo URLs", () => {
    it("GitHub repo URL: repo root on the default branch", () => {
      expect(parse("https://github.com/owner/repo")).toEqual({
        host: "github.com",
        owner: "owner",
        repo: "repo",
        cloneURL: "https://github.com/owner/repo.git",
        ref: undefined,
        path: undefined,
      })
    })

    it("tolerates a trailing slash, query and fragment", () => {
      for (const url of [
        "https://github.com/owner/repo/",
        "https://github.com/owner/repo?tab=readme",
        "https://github.com/owner/repo#readme",
      ]) {
        expect(parse(url).cloneURL).toBe("https://github.com/owner/repo.git")
      }
    })

    it("keeps ?ref=, as the shorthand and .git forms do", () => {
      expect(parse("https://github.com/owner/repo?ref=v1.0")).toEqual({
        host: "github.com",
        owner: "owner",
        repo: "repo",
        cloneURL: "https://github.com/owner/repo.git",
        ref: "v1.0",
        path: undefined,
      })
      const gitlab = parse("https://gitlab.com/group/sub/project?ref=v1.0")
      expect(gitlab.owner).toBe("group/sub")
      expect(gitlab.ref).toBe("v1.0")
    })

    it("GitLab repo URL", () => {
      expect(parse("https://gitlab.com/owner/repo").host).toBe("gitlab.com")
    })

    it("GitLab repo URL with nested groups", () => {
      const result = parse("https://gitlab.com/group/subgroup/project")
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
      expect(result.cloneURL).toBe("https://gitlab.com/group/subgroup/project.git")
    })

    it("GitLab repo URL with nested groups and .git suffix", () => {
      const result = parse("https://gitlab.com/group/subgroup/project.git")
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
      expect(result.path).toBeUndefined()
    })

    it("plain repo URL on a self-hosted GitLab instance", () => {
      const result = parse("https://gitlab.example.com/group/subgroup/project")
      expect(result.host).toBe("gitlab.example.com")
      expect(result.owner).toBe("group/subgroup")
      expect(result.cloneURL).toBe("https://gitlab.example.com/group/subgroup/project.git")
    })
  })

  // go-getter sources name the ref explicitly (or not at all), so they never
  // go through resolveRef — the regression was a ref-less
  // `github.com/o/r//dir` being split as if `dir` were a branch.
  describe("go-getter shorthand", () => {
    it("github.com/owner/repo//path?ref=…", () => {
      expect(parse("github.com/owner/repo//modules/vpc?ref=main")).toEqual({
        host: "github.com",
        owner: "owner",
        repo: "repo",
        cloneURL: "https://github.com/owner/repo.git",
        ref: "main",
        path: "modules/vpc",
      })
    })

    it("no ?ref= means the default branch, not an ambiguous ref/path", () => {
      const result = parse("github.com/owner/repo//runbooks/vpc")
      expect(result.ref).toBeUndefined()
      expect(result.path).toBe("runbooks/vpc")
      expect(result.refAndPath).toBeUndefined()
    })

    it("a path to runbook.mdx", () => {
      expect(parse("github.com/owner/repo//runbooks/vpc/runbook.mdx?ref=v1.2.0").path).toBe(
        "runbooks/vpc/runbook.mdx",
      )
    })

    it("github.com/owner/repo/path (go-getter's GitHub detector, no //)", () => {
      const result = parse("github.com/owner/repo/runbooks/vpc")
      expect(result.owner).toBe("owner")
      expect(result.repo).toBe("repo")
      expect(result.path).toBe("runbooks/vpc")
      expect(result.ref).toBeUndefined()
    })

    it("github.com/owner/repo with no path, with and without ?ref=", () => {
      expect(parse("github.com/owner/repo").path).toBeUndefined()
      expect(parse("github.com/owner/repo.git?ref=v1").ref).toBe("v1")
      expect(parse("github.com/owner/repo.git?ref=v1").repo).toBe("repo")
    })

    it("gitlab.com with nested groups needs // for the path", () => {
      const withPath = parse("gitlab.com/group/sub/project//runbooks/vpc?ref=main")
      expect(withPath.owner).toBe("group/sub")
      expect(withPath.repo).toBe("project")
      expect(withPath.path).toBe("runbooks/vpc")
      expect(withPath.cloneURL).toBe("https://gitlab.com/group/sub/project.git")
      const repoOnly = parse("gitlab.com/group/sub/project")
      expect(repoOnly.owner).toBe("group/sub")
      expect(repoOnly.path).toBeUndefined()
    })

    it("an empty // path is the repo root", () => {
      expect(parse("github.com/owner/repo//?ref=main").path).toBeUndefined()
    })
  })

  describe("go-getter git:: sources", () => {
    it("git::https URL with ref", () => {
      expect(parse("git::https://github.com/owner/repo.git//modules/vpc?ref=v1.0")).toEqual({
        host: "github.com",
        owner: "owner",
        repo: "repo",
        cloneURL: "https://github.com/owner/repo.git",
        ref: "v1.0",
        path: "modules/vpc",
      })
    })

    it("git::https URL without ref", () => {
      const result = parse("git::https://github.com/owner/repo.git//modules/vpc")
      expect(result.path).toBe("modules/vpc")
      expect(result.ref).toBeUndefined()
      expect(result.refAndPath).toBeUndefined()
    })

    it("git::https URL without a path", () => {
      const result = parse("git::https://github.com/owner/repo.git?ref=main")
      expect(result.path).toBeUndefined()
      expect(result.ref).toBe("main")
    })

    it("ignores go-getter's sshkey parameter", () => {
      const result = parse(
        `git::ssh://git@github.com/owner/repo.git//modules/vpc?ref=main&sshkey=${SSH_KEY}`,
      )
      expect(result.cloneURL).toBe("ssh://git@github.com/owner/repo.git")
      expect(result.path).toBe("modules/vpc")
      expect(result.ref).toBe("main")
    })

    it.each([
      "git::https://github.com/owner/repo.git//modules/vpc?ref=v1.0.0+build.1",
      "git::https://github.com/owner/repo.git//modules/vpc?ref=v1.0.0%2Bbuild.1",
      "github.com/owner/repo//modules/vpc?ref=v1.0.0+build.1",
      "https://github.com/owner/repo?ref=v1.0.0+build.1",
    ])("keeps a + in ?ref= (semver build metadata), never a space: %s", (url) => {
      expect(parse(url).ref).toBe("v1.0.0+build.1")
    })

    it("GitLab nested groups", () => {
      const result = parse(
        "git::https://gitlab.com/group/subgroup/project.git//modules/vpc?ref=v1.0",
      )
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
      expect(result.cloneURL).toBe("https://gitlab.com/group/subgroup/project.git")
    })

    it("an arbitrary git host clones the address as given (no .git added)", () => {
      const result = parse(
        "git::https://dev.example.com/org/project/_git/infra//runbooks/vpc?ref=main",
      )
      expect(result.host).toBe("dev.example.com")
      expect(result.owner).toBe("org/project/_git")
      expect(result.repo).toBe("infra")
      expect(result.cloneURL).toBe("https://dev.example.com/org/project/_git/infra")
    })

    it("drops credentials embedded in the URL", () => {
      expect(parse("git::https://user:secret@github.com/owner/repo.git//x").cloneURL).toBe(
        "https://github.com/owner/repo.git",
      )
    })

    it("keeps an explicit http:// transport", () => {
      expect(parse("git::http://git.internal/owner/repo.git//x").cloneURL).toBe(
        "http://git.internal/owner/repo.git",
      )
    })

    it("git::ssh:// URL", () => {
      const result = parse("git::ssh://git@github.com/owner/repo.git//runbooks/vpc?ref=main")
      expect(result.host).toBe("github.com")
      expect(result.owner).toBe("owner")
      expect(result.repo).toBe("repo")
      expect(result.cloneURL).toBe("ssh://git@github.com/owner/repo.git")
      expect(result.path).toBe("runbooks/vpc")
      expect(result.ref).toBe("main")
    })

    it("drops an ssh:// password but keeps the user and port", () => {
      expect(
        parse(withUserinfo("git::ssh", `git:${PASSWORD}`, "git.example.com:2222/owner/repo.git//x"))
          .cloneURL,
      ).toBe("ssh://git@git.example.com:2222/owner/repo.git")
      expect(
        parse(withUserinfo("ssh", `deploy:${PASSWORD}`, "github.com/owner/repo.git")).cloneURL,
      ).toBe("ssh://deploy@github.com/owner/repo.git")
    })

    it("keeps credentials out of the error for a source with no repository", () => {
      expect(
        parseError(withUserinfo("git::ssh", `git:${PASSWORD}`, "git.example.com/")),
      ).not.toContain(PASSWORD)
    })

    it("git:: with an scp-like SSH address", () => {
      const result = parse("git::git@gitlab.com:group/sub/project.git//runbooks/vpc")
      expect(result.host).toBe("gitlab.com")
      expect(result.owner).toBe("group/sub")
      expect(result.repo).toBe("project")
      expect(result.cloneURL).toBe("git@gitlab.com:group/sub/project.git")
      expect(result.path).toBe("runbooks/vpc")
    })
  })

  describe("git sources without git::", () => {
    it("https .git URL with a // path", () => {
      const result = parse("https://github.com/owner/repo.git//runbooks/vpc?ref=main")
      expect(result.cloneURL).toBe("https://github.com/owner/repo.git")
      expect(result.path).toBe("runbooks/vpc")
      expect(result.ref).toBe("main")
      expect(result.refAndPath).toBeUndefined()
    })

    it("https URL with a // path and no .git", () => {
      const result = parse("https://gitlab.com/group/sub/project//runbooks/vpc")
      expect(result.owner).toBe("group/sub")
      expect(result.repo).toBe("project")
      expect(result.path).toBe("runbooks/vpc")
    })

    it("scp-like SSH address", () => {
      const result = parse("git@github.com:owner/repo.git//runbooks/vpc?ref=v2")
      expect(result.cloneURL).toBe("git@github.com:owner/repo.git")
      expect(result.path).toBe("runbooks/vpc")
      expect(result.ref).toBe("v2")
    })

    it("ssh:// URL with a port", () => {
      const result = parse("ssh://git@git.example.com:2222/owner/repo.git")
      expect(result.host).toBe("git.example.com:2222")
      expect(result.cloneURL).toBe("ssh://git@git.example.com:2222/owner/repo.git")
      expect(result.path).toBeUndefined()
    })

    it("drops a #fragment rather than reading it into the ref or path", () => {
      const withRef = parse(
        "git::https://git.example.com/owner/repo.git//runbooks/vpc?ref=main#readme",
      )
      expect(withRef.ref).toBe("main")
      expect(withRef.path).toBe("runbooks/vpc")
      const noRef = parse("github.com/owner/repo//runbooks/vpc#readme")
      expect(noRef.ref).toBeUndefined()
      expect(noRef.path).toBe("runbooks/vpc")
    })
  })

  describe("invalid sources", () => {
    it("rejects an empty string", () => {
      expect(parseError("")).toBe("empty URL")
    })

    it("rejects an unsupported host with a message naming the accepted forms", () => {
      expect(parseError("https://bitbucket.org/owner/repo")).toContain("github.com/org/repo//path")
      expect(parseError("./local/path")).toContain("unsupported URL format")
    })

    it("rejects paths that climb out of the repository", () => {
      expect(parseError("github.com/owner/repo//../../etc?ref=main")).toContain(
        "must stay inside the repository",
      )
      // A literal `../` in a browser URL is collapsed by the URL parser; an
      // encoded slash survives it and reaches the path check.
      expect(parseError("https://github.com/owner/repo/tree/main/x%2F..%2F..%2Fy")).toContain(
        "must stay inside the repository",
      )
      expect(parseError("github.com/owner/repo//a\\..\\b")).toContain(
        "must stay inside the repository",
      )
    })

    it("rejects a shorthand with no repo", () => {
      expect(parseError("github.com/owner")).toContain("github.com/<owner>/<repo>")
    })

    it.each([
      `github.com/owner?sshkey=${SSH_KEY}`,
      `git::https://git.example.com/?sshkey=${SSH_KEY}`,
    ])("keeps an sshkey out of the error's url field and message: %s", (input) => {
      const result = Effect.runSync(Effect.either(parseRemoteSource(input)))
      if (result._tag === "Right") throw new Error(`expected ${input} to be rejected`)
      expect(result.left.url).toBe(redactSourceCredentials(input))
      expect(result.left.url).toContain("sshkey=[REDACTED]")
      expect(result.left.message).not.toContain(SSH_KEY)
    })

    it("rejects a git transport other than https, http or ssh", () => {
      expect(parseError("git::file:///srv/repo.git//x")).toContain("unsupported git transport")
    })

    it("rejects an scp-like address whose user starts with -", () => {
      expect(parseError("-u@host:repo")).toContain("unsupported URL format")
      expect(parseError("git::-u@host:repo")).toContain("unsupported URL format")
    })

    it.each([
      withUserinfo("https", `user:${PASSWORD}`, "bitbucket.org/owner/repo"),
      withUserinfo("https", `user:${PASSWORD}`, "gitlab.com/group/project/-/raw/main/x"),
      withUserinfo("git::https", `user:${PASSWORD}`, "git.example.com/"),
      withUserinfo("git::ssh", `git:${PASSWORD}`, "git.example.com/"),
      withUserinfo("https", `user:p@${PASSWORD}`, "bitbucket.org/owner/repo"),
      withUserinfo("ftp", `user:${PASSWORD}`, "host/o/r"),
      withUserinfo("git::ftp", `user:${PASSWORD}`, "host/o/r"),
      withUserinfo("git+https", `user:${PASSWORD}`, "host/o/r"),
      withUserinfo("git::git+https", `user:${PASSWORD}`, "host/o/r"),
      `user:${PASSWORD}@github.com/o/r`,
      `git::user:${PASSWORD}@host/o/r`,
      // A token posing as the user, which the URL parser reads as a scheme.
      `git::${PASSWORD}:x-oauth-basic@github.com/o/r`,
      // One `/`: the URL parser finds no host ("no repository in …").
      `git::ssh:/git:${PASSWORD}@host/o/r.git`,
    ])("keeps credentials out of the error's url field and message: %s", (input) => {
      // The url field ends up in logs, like the message.
      const result = Effect.runSync(Effect.either(parseRemoteSource(input)))
      if (result._tag === "Right") throw new Error(`expected ${input} to be rejected`)
      expect(result.left.url).not.toContain(PASSWORD)
      expect(result.left.url).toBe(redactSourceCredentials(input))
      expect(result.left.message).not.toContain(PASSWORD)
    })
  })
})

// ---------------------------------------------------------------------------
// resolveRef — picks the longest matching ref from `git ls-remote` output.
// ---------------------------------------------------------------------------

describe("resolveRef", () => {
  // ls-remote output: <sha>\t<refname>; refs/heads/<branch> or refs/tags/<tag>
  const refOutput = (names: string[]) => names.map((n, i) => `${"a".repeat(40)}${i}\t${n}`)

  it("picks the longest matching ref over a shorter one", async () => {
    const spawner = makeTestSpawner([
      {
        command: "git",
        args: ["ls-remote", "--refs", "--", "https://github.com/o/r.git"],
        outputLines: refOutput([
          "refs/heads/main",
          "refs/heads/release/v1",
          "refs/heads/release/v1.2",
        ]),
        exitCode: 0,
      },
    ])

    const result = await Effect.runPromise(
      resolveRef("https://github.com/o/r.git", "release/v1.2/foo/bar.md").pipe(
        Effect.provide(spawner),
      ),
    )

    expect(result.ref).toBe("release/v1.2")
    expect(result.path).toBe("foo/bar.md")
  })

  it("falls back to first-segment-is-ref when no candidate matches", async () => {
    const spawner = makeTestSpawner([
      {
        command: "git",
        args: ["ls-remote", "--refs", "--", "https://github.com/o/r.git"],
        outputLines: refOutput(["refs/heads/main"]),
        exitCode: 0,
      },
    ])

    const result = await Effect.runPromise(
      resolveRef("https://github.com/o/r.git", "unknown/dir/file.md").pipe(Effect.provide(spawner)),
    )

    expect(result.ref).toBe("unknown")
    expect(result.path).toBe("dir/file.md")
  })

  it("returns undefined path when the ref exhausts the segments", async () => {
    const spawner = makeTestSpawner([
      {
        command: "git",
        args: ["ls-remote", "--refs", "--", "https://github.com/o/r.git"],
        outputLines: refOutput(["refs/heads/main"]),
        exitCode: 0,
      },
    ])

    const result = await Effect.runPromise(
      resolveRef("https://github.com/o/r.git", "main").pipe(Effect.provide(spawner)),
    )

    expect(result.ref).toBe("main")
    expect(result.path).toBeUndefined()
  })

  it("strips refs/tags/ prefix so a tag matches by its bare name", async () => {
    const spawner = makeTestSpawner([
      {
        command: "git",
        args: ["ls-remote", "--refs", "--", "https://github.com/o/r.git"],
        outputLines: refOutput(["refs/tags/v1.0.0"]),
        exitCode: 0,
      },
    ])

    const result = await Effect.runPromise(
      resolveRef("https://github.com/o/r.git", "v1.0.0/README.md").pipe(Effect.provide(spawner)),
    )

    expect(result.ref).toBe("v1.0.0")
    expect(result.path).toBe("README.md")
  })

  it("fails with a redacted GitError instead of guessing a ref when ls-remote fails", async () => {
    const url = "https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git"
    const spawner = makeTestSpawner([
      {
        command: "git",
        args: ["ls-remote", "--refs", "--", url],
        outputLines: [`fatal: unable to access '${url}/': Could not resolve host: github.com`],
        source: "stderr",
        exitCode: 128,
      },
    ])

    const result = await Effect.runPromise(
      resolveRef(url, "feature/foo/runbooks/x").pipe(Effect.provide(spawner), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("GitError")
      if (result.left._tag === "GitError") {
        expect(result.left.exitCode).toBe(128)
        expect(result.left.stderr).toContain("Could not resolve host")
        expect(result.left.stderr).not.toContain("ghp_")
      }
    }
  })
})

// ---------------------------------------------------------------------------
// GitHub Enterprise hosts (GHES / ghe.com)
// ---------------------------------------------------------------------------

describe("parseRemoteSource — GitHub enterprise hosts", () => {
  const parseWith = (url: string, githubHosts?: string[]) =>
    Effect.runSync(parseRemoteSource(url, githubHosts ? { githubHosts } : {}))
  const parseEither = (url: string, githubHosts?: string[]) =>
    Effect.runSync(Effect.either(parseRemoteSource(url, githubHosts ? { githubHosts } : {})))

  it("parses a GHES tree URL with that host and clone URL", () => {
    const result = parseWith("https://ghes.example.com/owner/repo/tree/main/path/to/dir")
    expect(result).toEqual({
      host: "ghes.example.com",
      owner: "owner",
      repo: "repo",
      cloneURL: "https://ghes.example.com/owner/repo.git",
      ref: undefined,
      path: undefined,
      refAndPath: "main/path/to/dir",
    })
  })

  it("parses a GHES blob URL (lowercases the host, keeps the port)", () => {
    const result = parseWith("https://GHES.Example.com:8443/owner/repo/blob/v1.2/runbook.mdx")
    expect(result.host).toBe("ghes.example.com:8443")
    expect(result.cloneURL).toBe("https://ghes.example.com:8443/owner/repo.git")
    expect(result.refAndPath).toBe("v1.2/runbook.mdx")
  })

  it("parses ghe.com tree and blob URLs", () => {
    const tree = parseWith("https://acme.ghe.com/o/r/tree/main/dir")
    expect(tree.host).toBe("acme.ghe.com")
    expect(tree.cloneURL).toBe("https://acme.ghe.com/o/r.git")
    const blob = parseWith("https://acme.ghe.com/o/r/blob/main/dir/runbook.mdx")
    expect(blob.host).toBe("acme.ghe.com")
    expect(blob.refAndPath).toBe("main/dir/runbook.mdx")
  })

  it("an http:// browser URL still clones over https", () => {
    expect(parseWith("http://ghes.example.com/o/r/tree/main").cloneURL).toBe(
      "https://ghes.example.com/o/r.git",
    )
  })

  it("plain ghe.com repo URL parses without configuration", () => {
    for (const url of [
      "https://acme.ghe.com/o/r",
      "https://acme.ghe.com/o/r.git",
      "https://ACME.ghe.com/o/r",
    ]) {
      const result = parseWith(url)
      expect(result.host).toBe("acme.ghe.com")
      expect(result.owner).toBe("o")
      expect(result.repo).toBe("r")
      expect(result.cloneURL).toBe("https://acme.ghe.com/o/r.git")
    }
  })

  it("plain GHES repo URL parses ONLY when its host is in githubHosts", () => {
    expect(parseEither("https://ghes.example.com/o/r")._tag).toBe("Left")
    expect(parseEither("https://ghes.example.com/o/r", ["other.example.com"])._tag).toBe("Left")
    const result = parseWith("https://ghes.example.com/o/r", ["GHES.example.com"])
    expect(result).toEqual({
      host: "ghes.example.com",
      owner: "o",
      repo: "r",
      cloneURL: "https://ghes.example.com/o/r.git",
      ref: undefined,
      path: undefined,
    })
  })

  it("a .git clone URL names a git repo on any host, configured or not", () => {
    expect(parseWith("https://ghes.example.com/o/r.git").cloneURL).toBe(
      "https://ghes.example.com/o/r.git",
    )
  })

  it("plain github.com still parses without githubHosts", () => {
    expect(parseWith("https://github.com/o/r").cloneURL).toBe("https://github.com/o/r.git")
  })

  it("a GitLab-named host listed nowhere still parses as GitLab (githubHosts doesn't hijack it)", () => {
    const result = parseWith("https://gitlab.example.com/group/sub/project", ["ghes.example.com"])
    expect(result.owner).toBe("group/sub")
    expect(result.repo).toBe("project")
  })

  it("GitLab /-/tree/ URLs are not mistaken for GitHub tree URLs", () => {
    const result = parseWith("https://gitlab.example.com/group/project/-/tree/main/dir")
    expect(result.owner).toBe("group")
    expect(result.repo).toBe("project")
    expect(result.refAndPath).toBe("main/dir")
  })

  // The GitHub tree/blob shape matches any host, so a plain URL of a GitLab
  // project nested under a subgroup literally named `tree`/`blob`
  // (`group/team/blob/project`) must not misparse as GitHub `group/team`.
  it("a plain GitLab URL with a `blob`/`tree` subgroup still parses as GitLab", () => {
    const result = parseWith("https://gitlab.com/group/team/blob/project")
    expect(result.owner).toBe("group/team/blob")
    expect(result.repo).toBe("project")
    expect(result.cloneURL).toBe("https://gitlab.com/group/team/blob/project.git")
  })
})
