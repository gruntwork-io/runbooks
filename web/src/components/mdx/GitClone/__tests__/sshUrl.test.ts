import { describe, it, expect } from "vitest"
import { isSshAuthError, sshRemoteForSignIn } from "../sshUrl"

describe("sshRemoteForSignIn", () => {
  it.each([
    ["git@gitlab.com:group/project.git", "gitlab.com", "https://gitlab.com/group/project.git"],
    [
      "git@gitlab.com:gruntwork-io/demo/infrastructure-live-azure.git",
      "gitlab.com",
      "https://gitlab.com/gruntwork-io/demo/infrastructure-live-azure.git",
    ],
    ["git@github.com:acme/infra", "github.com", "https://github.com/acme/infra"],
    [
      "ssh://git@gitlab.com/group/sub/project.git",
      "gitlab.com",
      "https://gitlab.com/group/sub/project.git",
    ],
    // The SSH port is dropped; the sign-in's host keeps its web port.
    [
      "ssh://git@gitlab.corp:2222/group/project.git",
      "gitlab.corp",
      "https://gitlab.corp/group/project.git",
    ],
    [
      "ssh://git@gitlab.corp:2222/group/sub/project.git",
      "gitlab.corp:8443",
      "https://gitlab.corp:8443/group/sub/project.git",
    ],
    [
      "[git@gitlab.corp:2222]:group/project.git",
      "gitlab.corp:8443",
      "https://gitlab.corp:8443/group/project.git",
    ],
    [
      "git+ssh://git@GitLab.com/group/project.git",
      "gitlab.com",
      "https://gitlab.com/group/project.git",
    ],
  ])("rewrites %s for %s", (url, host, https) => {
    expect(sshRemoteForSignIn(url, host)).toEqual({ httpsUrl: https })
  })

  it.each([
    "https://gitlab.com/group/project.git",
    "http://gitlab.com/group/project.git",
    "/home/me/repo",
    "file:///srv/repo.git",
    "",
  ])("ignores %s, which is not an SSH remote", (url) => {
    expect(sshRemoteForSignIn(url, "gitlab.com")).toBeUndefined()
  })

  it("ignores an SSH remote on a host other than the sign-in's", () => {
    expect(sshRemoteForSignIn("git@github.com:acme/infra.git", "gitlab.com")).toBeUndefined()
    expect(sshRemoteForSignIn("git@gitlab.com:g/p.git", "gitlab.example.com")).toBeUndefined()
  })

  it.each([
    "git@gitlab.com:/srv/git/project.git",
    "git@gitlab.com:~me/project.git",
    "git@gitlab.com:project.git",
    "ssh://git@gitlab.com/~me/project.git",
    "git@gitlab.com:group/../project.git",
    "git@gitlab.com:group/pro%20ject.git",
  ])("offers no HTTPS URL for %s", (url) => {
    expect(sshRemoteForSignIn(url, "gitlab.com")).toEqual({ httpsUrl: undefined })
  })
})

describe("isSshAuthError", () => {
  it.each([
    "no such identity: /home/me/.ssh/gruntwork_gitlab: No such file or directory\ngit@gitlab.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    "Host key verification failed.\nfatal: Could not read from remote repository.",
    "Received disconnect from 1.2.3.4 port 22:2: Too many authentication failures",
    'Load key "/home/me/.ssh/id_ed25519": invalid format',
  ])("matches %s", (message) => {
    expect(isSshAuthError(message)).toBe(true)
  })

  it.each([
    "remote: HTTP Basic: Access denied",
    "fatal: repository 'https://gitlab.com/g/p.git/' not found",
    "Could not resolve hostname gitlab.corp",
  ])("does not match %s", (message) => {
    expect(isSshAuthError(message)).toBe(false)
  })
})
