import { describe, it, expect } from "bun:test"
import { gitCredentialUsername, stripUrlCredentials, withGitHttpAuth } from "./url.ts"

const TOKEN = "ghp_TESTTOKEN1234567890"

/** Decode the basic-auth credentials out of an `Authorization: Basic …` header value. */
const decodeBasic = (header: string | undefined) =>
  atob((header ?? "").replace(/^Authorization: Basic /, ""))

describe("gitCredentialUsername", () => {
  it("uses `oauth2` for GitLab", () => {
    expect(gitCredentialUsername("gitlab")).toBe("oauth2")
  })

  it("uses `x-access-token` for GitHub and when the provider is unknown", () => {
    expect(gitCredentialUsername("github")).toBe("x-access-token")
    expect(gitCredentialUsername(undefined)).toBe("x-access-token")
  })
})

describe("stripUrlCredentials", () => {
  it.each([
    [`https://x-access-token:${TOKEN}@github.com/owner/repo.git`, "https://github.com/owner/repo.git"],
    [`https://oauth2:${TOKEN}@gitlab.example.com:8443/group/sub/proj.git`, "https://gitlab.example.com:8443/group/sub/proj.git"],
    [`http://${TOKEN}@git.corp.net/team/repo`, "http://git.corp.net/team/repo"],
  ])("removes the userinfo from %s", (input, expected) => {
    const result = stripUrlCredentials(input)
    expect(result).toBe(expected)
    expect(result).not.toContain(TOKEN)
  })

  it("returns a credential-free http(s) URL exactly as given", () => {
    // No re-serialization: a URL without userinfo round-trips byte for byte.
    for (const url of ["https://github.com/owner/repo", "https://GitHub.com/owner/repo.git"]) {
      expect(stripUrlCredentials(url)).toBe(url)
    }
  })

  it.each([
    "ssh://git@gitlab.example.com:2222/group/proj.git",
    "git@github.com:owner/repo.git",
    "git://example.com/x.git",
    "/srv/git/repo.git",
    "",
    "not a url",
  ])("leaves %p unchanged", (url) => {
    expect(stripUrlCredentials(url)).toBe(url)
  })
})

describe("withGitHttpAuth", () => {
  const base = { PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "0" }

  it("authenticates an https URL through env-based git config", () => {
    const env = withGitHttpAuth(base, "https://gitlab.example.com:8443/group/proj.git", TOKEN, "oauth2")

    expect(env).toEqual({
      ...base,
      GIT_CONFIG_COUNT: "3",
      // Reset the user's credential helpers so a rejected token can't make git
      // fall back to (and then erase) the user's own saved login.
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      // Reset, then set, the auth header for the URL's origin.
      GIT_CONFIG_KEY_1: "http.https://gitlab.example.com:8443/.extraHeader",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "http.https://gitlab.example.com:8443/.extraHeader",
      GIT_CONFIG_VALUE_2: expect.stringMatching(/^Authorization: Basic /),
    })
    expect(decodeBasic(env.GIT_CONFIG_VALUE_2)).toBe(`oauth2:${TOKEN}`)
  })

  it("defaults the username to `x-access-token`", () => {
    const env = withGitHttpAuth(base, "https://github.com/owner/repo.git", TOKEN)
    expect(decodeBasic(env.GIT_CONFIG_VALUE_2)).toBe(`x-access-token:${TOKEN}`)
  })

  it("keeps the token out of every config key, and scopes the header to the origin alone", () => {
    const env = withGitHttpAuth(base, `https://olduser:oldpass@github.com/owner/repo.git`, TOKEN)

    const keys = Object.keys(env)
      .filter((k) => k.startsWith("GIT_CONFIG_KEY_"))
      .map((k) => env[k])
    expect(keys).toContain("http.https://github.com/.extraHeader")
    for (const key of keys) {
      expect(key).not.toContain(TOKEN)
      expect(key).not.toContain("olduser")
    }
    // The fresh token wins over whatever userinfo the URL carried.
    expect(decodeBasic(env.GIT_CONFIG_VALUE_2)).toBe(`x-access-token:${TOKEN}`)
  })

  it("appends after config entries the environment already carries", () => {
    const withExisting = {
      ...base,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "user.name",
      GIT_CONFIG_VALUE_1: "Someone",
    }

    const env = withGitHttpAuth(withExisting, "https://github.com/owner/repo.git", TOKEN)

    expect(env.GIT_CONFIG_COUNT).toBe("5")
    expect(env.GIT_CONFIG_KEY_0).toBe("core.autocrlf")
    expect(env.GIT_CONFIG_KEY_1).toBe("user.name")
    expect(env.GIT_CONFIG_KEY_2).toBe("credential.helper")
    expect(env.GIT_CONFIG_KEY_4).toBe("http.https://github.com/.extraHeader")
    // The caller's env object is not mutated.
    expect(withExisting.GIT_CONFIG_COUNT).toBe("2")
  })

  it.each([
    // An SSH remote keeps its own user and port; a token has no place there.
    "ssh://git@gitlab.example.com:2222/group/proj.git",
    "git@github.com:owner/repo.git",
    "git://example.com/x.git",
    "file:///srv/git/repo.git",
    "/srv/git/repo.git",
    "not a url",
  ])("returns the environment unchanged for the non-http(s) URL %p", (url) => {
    expect(withGitHttpAuth(base, url, TOKEN)).toBe(base)
  })

  it("returns the environment unchanged when there is no token", () => {
    expect(withGitHttpAuth(base, "https://github.com/owner/repo.git", undefined)).toBe(base)
    expect(withGitHttpAuth(base, "https://github.com/owner/repo.git", "")).toBe(base)
  })
})
