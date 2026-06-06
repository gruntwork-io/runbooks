import { describe, it, expect } from "bun:test"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import {
  isRemoteURL,
  isAuthError,
  authHintForHost,
  classifyCloneError,
  cleanupTempClones,
  registerTempCloneDir,
} from "./remote.ts"

describe("isRemoteURL", () => {
  it("detects HTTPS GitHub URLs", () => {
    expect(isRemoteURL("https://github.com/owner/repo/tree/main/path")).toBe(true)
  })

  it("detects HTTPS GitLab URLs", () => {
    expect(isRemoteURL("https://gitlab.com/owner/repo/-/tree/main/path")).toBe(true)
  })

  it("detects HTTP URLs", () => {
    expect(isRemoteURL("http://github.com/owner/repo")).toBe(true)
  })

  it("detects git:: prefix URLs", () => {
    expect(isRemoteURL("git::https://github.com/owner/repo.git//path?ref=v1.0")).toBe(true)
  })

  it("detects GitHub shorthand", () => {
    expect(isRemoteURL("github.com/owner/repo//path")).toBe(true)
  })

  it("detects GitLab shorthand", () => {
    expect(isRemoteURL("gitlab.com/owner/repo//path")).toBe(true)
  })

  it("rejects local paths", () => {
    expect(isRemoteURL("./path/to/runbook.mdx")).toBe(false)
    expect(isRemoteURL("/absolute/path/to/runbook.mdx")).toBe(false)
    expect(isRemoteURL("relative/path")).toBe(false)
  })

  it("rejects bare filenames", () => {
    expect(isRemoteURL("runbook.mdx")).toBe(false)
  })

  it("handles whitespace", () => {
    expect(isRemoteURL("  https://github.com/owner/repo  ")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isAuthError
// ---------------------------------------------------------------------------

describe("isAuthError", () => {
  it.each([
    "fatal: Authentication failed for 'https://github.com/x/y.git/'",
    "remote: HTTP/2 stream 1 was not closed cleanly: PROTOCOL_ERROR (err 1), 403 forbidden",
    "fatal: unable to access 'https://...': The requested URL returned error: 401",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "remote: Invalid credentials",
    "fatal: Permission denied (publickey)",
  ])("classifies %s as auth", (stderr) => {
    expect(isAuthError(stderr)).toBe(true)
  })

  it.each([
    "",
    "fatal: repository 'https://github.com/x/y.git/' not found",
    "fatal: could not resolve host: github.com",
    "fatal: unable to find a suitable file for index pack",
  ])("returns false for non-auth stderr: %s", (stderr) => {
    expect(isAuthError(stderr)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// authHintForHost
// ---------------------------------------------------------------------------

describe("authHintForHost", () => {
  it("returns a GitHub-specific hint mentioning GITHUB_TOKEN", () => {
    const hint = authHintForHost("github.com")
    expect(hint).toContain("GITHUB_TOKEN")
    expect(hint.toLowerCase()).toContain("github")
  })

  it("returns a GitLab-specific hint mentioning GITLAB_TOKEN", () => {
    const hint = authHintForHost("gitlab.com")
    expect(hint).toContain("GITLAB_TOKEN")
  })

  it("returns a generic fallback that names the host", () => {
    const hint = authHintForHost("bitbucket.org")
    expect(hint).toContain("bitbucket.org")
  })
})

// ---------------------------------------------------------------------------
// classifyCloneError
// ---------------------------------------------------------------------------

describe("classifyCloneError", () => {
  it("classifies auth failure on github.com with the GitHub hint", () => {
    const result = classifyCloneError(
      "github.com",
      "fatal: Authentication failed for 'https://github.com/o/r.git/'",
    )
    expect(result.kind).toBe("auth")
    expect(result.hint).toContain("GITHUB_TOKEN")
  })

  it("classifies auth failure on gitlab.com with the GitLab hint", () => {
    const result = classifyCloneError(
      "gitlab.com",
      "fatal: Authentication failed for 'https://gitlab.com/g/p.git/'",
    )
    expect(result.kind).toBe("auth")
    expect(result.hint).toContain("GITLAB_TOKEN")
  })

  it("classifies a repository-not-found stderr", () => {
    const result = classifyCloneError(
      "github.com",
      "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
    )
    expect(result.kind).toBe("not-found")
    expect(result.hint).toContain("github.com")
  })

  it("classifies DNS / network errors", () => {
    const result = classifyCloneError(
      "github.com",
      "fatal: unable to access 'https://github.com/o/r': Could not resolve host: github.com",
    )
    expect(result.kind).toBe("network")
  })

  it("classifies connection refused as network", () => {
    const result = classifyCloneError(
      "github.com",
      "fatal: unable to access 'https://github.com/o/r': Failed to connect to host: Connection refused",
    )
    expect(result.kind).toBe("network")
  })

  it("falls back to unknown for unrecognised stderr", () => {
    const result = classifyCloneError(
      "github.com",
      "fatal: index-pack failed",
    )
    expect(result.kind).toBe("unknown")
  })

  it("falls back to unknown for empty stderr", () => {
    const result = classifyCloneError("github.com", "")
    expect(result.kind).toBe("unknown")
  })
})

// ---------------------------------------------------------------------------
// cleanupTempClones
// ---------------------------------------------------------------------------

describe("cleanupTempClones", () => {
  it("removes every registered temp dir", () => {
    const a = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "rb-temp-a-"))
    const b = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "rb-temp-b-"))
    nodeFs.writeFileSync(nodePath.join(a, "child.txt"), "x")
    registerTempCloneDir(a)
    registerTempCloneDir(b)

    cleanupTempClones()

    expect(nodeFs.existsSync(a)).toBe(false)
    expect(nodeFs.existsSync(b)).toBe(false)
  })

  it("tolerates a registered directory that was already deleted", () => {
    const a = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "rb-temp-c-"))
    registerTempCloneDir(a)
    // Pre-emptively remove the dir to simulate a prior cleanup.
    nodeFs.rmSync(a, { recursive: true, force: true })

    expect(() => cleanupTempClones()).not.toThrow()
    expect(nodeFs.existsSync(a)).toBe(false)
  })

  it("clears the internal registry so a second call is a no-op", () => {
    const a = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "rb-temp-d-"))
    registerTempCloneDir(a)
    cleanupTempClones()
    // After first cleanup the registry is empty — re-create the dir and call
    // cleanup again. The second call should NOT remove the recreated dir
    // (because it was never re-registered).
    nodeFs.mkdirSync(a, { recursive: true })
    cleanupTempClones()
    expect(nodeFs.existsSync(a)).toBe(true)
    nodeFs.rmSync(a, { recursive: true, force: true })
  })
})
