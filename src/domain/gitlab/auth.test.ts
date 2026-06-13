import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import {
  detectTokenType,
  detectEnvCredentials,
  detectCliCredentialsForHost,
  readGlabTokenForHost,
  detectConfigCredentials,
  detectConfigHosts,
  detectHostMeta,
  collectGlabCaCertPems,
  resolveGlabConfigPaths,
  parseGlabToken,
  parseGlabExpiry,
  readGlabHostMeta,
  enumerateGlabHosts,
  envTokenHost,
  mayAutoSendEnvToken,
} from "./auth.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { makeRecordingSpawner } from "../../test-utils/TestSpawner.ts"
import { makeTestFileSystem } from "../../test-utils/TestFileSystem.ts"

describe("detectTokenType", () => {
  it("identifies a personal access token", () => {
    expect(detectTokenType("glpat-abc123")).toBe("pat")
  })

  it("returns unknown for an unrecognized prefix", () => {
    expect(detectTokenType("random_token")).toBe("unknown")
  })

  it("returns unknown for an empty string", () => {
    expect(detectTokenType("")).toBe("unknown")
  })
})

describe("detectEnvCredentials", () => {
  it("returns GITLAB_TOKEN when set", async () => {
    const layer = makeTestEnvironment({ GITLAB_TOKEN: "glpat-test123" })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toEqual({ token: "glpat-test123", envVar: "GITLAB_TOKEN" })
  })

  it("follows glab's documented precedence: GITLAB_TOKEN > GITLAB_ACCESS_TOKEN > OAUTH_TOKEN", async () => {
    const all = makeTestEnvironment({
      GITLAB_TOKEN: "glpat-first",
      GITLAB_ACCESS_TOKEN: "glpat-second",
      OAUTH_TOKEN: "a".repeat(64),
    })
    expect(
      (await Effect.runPromise(detectEnvCredentials().pipe(Effect.provide(all))))?.envVar,
    ).toBe("GITLAB_TOKEN")

    const secondOnly = makeTestEnvironment({
      GITLAB_ACCESS_TOKEN: "glpat-second",
      OAUTH_TOKEN: "a".repeat(64),
    })
    expect(
      (await Effect.runPromise(detectEnvCredentials().pipe(Effect.provide(secondOnly))))?.envVar,
    ).toBe("GITLAB_ACCESS_TOKEN")
  })

  it("honors OAUTH_TOKEN — a real, glab-honored legacy credential (§2.2 #1)", async () => {
    const layer = makeTestEnvironment({ OAUTH_TOKEN: "b".repeat(64) })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toEqual({ token: "b".repeat(64), envVar: "OAUTH_TOKEN" })
  })

  it("returns undefined when none is set", async () => {
    const layer = makeTestEnvironment({})
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })

  it("does not read GITHUB_TOKEN", async () => {
    const layer = makeTestEnvironment({ GITHUB_TOKEN: "ghp_should_be_ignored" })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })
})

describe("envTokenHost — the §2.2 binding rule", () => {
  it("binds to gitlab.com by default", () => {
    expect(envTokenHost({})).toBe("gitlab.com")
  })

  it("follows glab's env precedence: GITLAB_HOST > GITLAB_URI > GL_HOST", () => {
    expect(envTokenHost({ GITLAB_HOST: "one.example", GITLAB_URI: "two.example", GL_HOST: "three.example" })).toBe("one.example")
    expect(envTokenHost({ GITLAB_URI: "two.example", GL_HOST: "three.example" })).toBe("two.example")
    expect(envTokenHost({ GL_HOST: "three.example" })).toBe("three.example")
  })

  it("normalizes URLs, ports, and trailing slashes", () => {
    expect(envTokenHost({ GITLAB_HOST: "https://git.corp.example/" })).toBe("git.corp.example")
    expect(envTokenHost({ GITLAB_HOST: "git.corp.example:8443" })).toBe("git.corp.example:8443")
  })

  it("the env token is NEVER sendable to a host other than envHost", () => {
    // The single security property of record (§8): glab-config hosts, recents,
    // session hosts, and authored hosts are all excluded — only envHost.
    const env = { GITLAB_HOST: "git.corp.example" }
    expect(mayAutoSendEnvToken("git.corp.example", env)).toBe(true)
    expect(mayAutoSendEnvToken("gitlab.com", env)).toBe(false)
    expect(mayAutoSendEnvToken("evil.example", env)).toBe(false)

    // Default binding: gitlab.com only.
    expect(mayAutoSendEnvToken("gitlab.com", {})).toBe(true)
    expect(mayAutoSendEnvToken("git.corp.example", {})).toBe(false)
  })

  it("an unparseable host var yields NO binding — never a silent gitlab.com rebind", () => {
    // A typo'd corporate host must not transmit the corporate token to
    // gitlab.com (the cross-origin disclosure §2.2 forbids).
    const env = { GITLAB_HOST: "git.corp.example:badport" }
    expect(envTokenHost(env)).toBeUndefined()
    expect(mayAutoSendEnvToken("gitlab.com", env)).toBe(false)
    expect(mayAutoSendEnvToken("git.corp.example", env)).toBe(false)
  })

  it("empty/blank host vars count as unset, not as a gitlab.com binding", () => {
    // glab precedence with '' set must fall through to the next var, not
    // short-circuit the chain.
    expect(envTokenHost({ GITLAB_HOST: "", GITLAB_URI: "git.corp.example" })).toBe("git.corp.example")
    expect(envTokenHost({ GITLAB_HOST: "  ", GL_HOST: "git.corp.example" })).toBe("git.corp.example")
    expect(envTokenHost({ GITLAB_HOST: "" })).toBe("gitlab.com")
  })
})

describe("detectCliCredentialsForHost — the three §2.2 exit contracts", () => {
  const HOST = "gitlab.example.com"

  it("contract (a): exit 0 + token on stdout, with per-host argv and child-env hygiene", async () => {
    const { layer, calls } = makeRecordingSpawner(() => ({
      lines: [{ line: "glpat-per-host", source: "stdout" }],
      exitCode: 0,
    }))
    const env = makeTestEnvironment({
      GITLAB_TOKEN: "glpat-ambient",
      GITLAB_ACCESS_TOKEN: "glpat-ambient2",
      OAUTH_TOKEN: "c".repeat(64),
      NO_PROMPT: "true",
      PATH: "/usr/bin",
    })

    const result = await Effect.runPromise(
      detectCliCredentialsForHost(HOST).pipe(Effect.provide(Layer.merge(layer, env))),
    )

    expect(result).toEqual({ kind: "token", token: "glpat-per-host" })
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe("glab")
    expect(calls[0].args).toEqual(["config", "get", "token", "--host", HOST])
    // Hygiene (§2.2): ambient tokens stripped — they override per-host reads
    // INSIDE glab — incl. OAUTH_TOKEN; kill switches set. NO_PROMPT is
    // stripped too (ambient included): it is deprecated in glab, and setting
    // it makes glab print a warning on STDOUT ahead of every parsed payload.
    expect(calls[0].env!.GITLAB_TOKEN).toBeUndefined()
    expect(calls[0].env!.GITLAB_ACCESS_TOKEN).toBeUndefined()
    expect(calls[0].env!.OAUTH_TOKEN).toBeUndefined()
    expect(calls[0].env!.GLAB_CHECK_UPDATE).toBe("false")
    expect(calls[0].env!.GLAB_SEND_TELEMETRY).toBe("false")
    expect(calls[0].env!.GLAB_NO_PROMPT).toBe("true")
    expect(calls[0].env!.NO_PROMPT).toBeUndefined()
    expect(calls[0].env!.NO_COLOR).toBe("1")
    expect(calls[0].env!.PATH).toBe("/usr/bin")
  })

  it("contract (b): exit 0 + empty stdout = host not configured, never an error", async () => {
    const { layer } = makeRecordingSpawner(() => ({ lines: [], exitCode: 0 }))
    const result = await Effect.runPromise(
      detectCliCredentialsForHost(HOST).pipe(
        Effect.provide(Layer.merge(layer, makeTestEnvironment())),
      ),
    )
    expect(result).toEqual({ kind: "absent" })
  })

  it("contract (c): exit 1 + stderr `not found in keyring` = keyring-blocked", async () => {
    const { layer } = makeRecordingSpawner(() => ({
      lines: [{ line: "failed to get token: secret not found in keyring", source: "stderr" }],
      exitCode: 1,
    }))
    const result = await Effect.runPromise(
      detectCliCredentialsForHost(HOST).pipe(
        Effect.provide(Layer.merge(layer, makeTestEnvironment())),
      ),
    )
    expect(result).toEqual({ kind: "keyring-blocked" })
  })

  it("spawn ENOENT = not-installed (gates the binary-absent config.yml fallback)", async () => {
    const { layer } = makeRecordingSpawner(() => "ENOENT")
    const result = await Effect.runPromise(
      detectCliCredentialsForHost(HOST).pipe(
        Effect.provide(Layer.merge(layer, makeTestEnvironment())),
      ),
    )
    expect(result).toEqual({ kind: "not-installed" })
  })

  it("any other failure mode degrades to absent — never breakage (§11)", async () => {
    const { layer } = makeRecordingSpawner(() => ({
      lines: [{ line: "some unexpected error", source: "stderr" }],
      exitCode: 2,
    }))
    const result = await Effect.runPromise(
      detectCliCredentialsForHost(HOST).pipe(
        Effect.provide(Layer.merge(layer, makeTestEnvironment())),
      ),
    )
    expect(result).toEqual({ kind: "absent" })
  })

  it("serializes concurrent reads for the same host through the per-host semaphore", async () => {
    const { layer, calls, maxConcurrent } = makeRecordingSpawner(
      () => ({ lines: [{ line: "glpat-x", source: "stdout" }], exitCode: 0 }),
      { delayMs: 15 },
    )
    const full = Layer.merge(layer, makeTestEnvironment())
    // Use a host name unique to this test: the semaphore registry is keyed by
    // host and shared module-wide.
    const host = "serialize.example.com"
    await Effect.runPromise(
      Effect.all(
        [
          detectCliCredentialsForHost(host).pipe(Effect.provide(full)),
          detectCliCredentialsForHost(host).pipe(Effect.provide(full)),
        ],
        { concurrency: "unbounded" },
      ),
    )
    expect(calls).toHaveLength(2)
    // glab rewrites config.yml with no locking — our spawns must never overlap.
    expect(maxConcurrent()).toBe(1)
  })
})

describe("resolveGlabConfigPaths", () => {
  it("probes the legacy ~/.config before the macOS platform path on darwin", () => {
    const paths = resolveGlabConfigPaths({
      env: { HOME: "/Users/x" },
      platform: "darwin",
    })
    const legacyIdx = paths.indexOf("/Users/x/.config/glab-cli/config.yml")
    const libIdx = paths.indexOf(
      "/Users/x/Library/Application Support/glab-cli/config.yml",
    )
    // glab checks the legacy location first, then the macOS default.
    expect(legacyIdx).toBe(0)
    expect(libIdx).toBeGreaterThan(legacyIdx)
  })

  it("uses ~/.config on linux", () => {
    const paths = resolveGlabConfigPaths({
      env: { HOME: "/home/x" },
      platform: "linux",
    })
    expect(paths).toEqual(["/home/x/.config/glab-cli/config.yml"])
  })

  it("uses %LOCALAPPDATA% on win32, after the legacy ~/.config probe", () => {
    const paths = resolveGlabConfigPaths({
      env: { USERPROFILE: "C:/Users/x", LOCALAPPDATA: "C:/Users/x/AppData/Local" },
      platform: "win32",
    })
    // Legacy ~/.config is probed first, then %LOCALAPPDATA% (not Roaming).
    expect(paths[0]).toContain(".config")
    expect(
      paths.some((p) => p.includes("AppData/Local") && p.includes("glab-cli")),
    ).toBe(true)
    expect(paths.some((p) => p.includes("Roaming"))).toBe(false)
  })

  it("prioritizes GLAB_CONFIG_DIR, then legacy ~/.config, then XDG_CONFIG_HOME", () => {
    const paths = resolveGlabConfigPaths({
      env: { HOME: "/home/x", GLAB_CONFIG_DIR: "/cfg", XDG_CONFIG_HOME: "/xdg" },
      platform: "linux",
    })
    expect(paths[0]).toBe("/cfg/config.yml")
    expect(paths[1]).toBe("/home/x/.config/glab-cli/config.yml")
    expect(paths[2]).toBe("/xdg/glab-cli/config.yml")
  })
})

describe("parseGlabToken", () => {
  it("extracts a !!null-tagged gitlab.com token (glab's obfuscation)", () => {
    const yaml =
      "host: gitlab.com\n" +
      "hosts:\n" +
      "  gitlab.com:\n" +
      "    token: !!null glpat-from_config\n" +
      "    user: tester\n"
    expect(parseGlabToken(yaml)).toBe("glpat-from_config")
  })

  it("extracts a plain (untagged) token", () => {
    const yaml = "hosts:\n  gitlab.com:\n    token: glpat-plain\n"
    expect(parseGlabToken(yaml)).toBe("glpat-plain")
  })

  it("extracts an opaque OAuth token (no glpat- prefix)", () => {
    const yaml =
      "hosts:\n  gitlab.com:\n    token: !!null eb57f299deadbeef\n    is_oauth2: \"true\"\n"
    expect(parseGlabToken(yaml)).toBe("eb57f299deadbeef")
  })

  it("returns undefined when there is no gitlab.com host", () => {
    const yaml = "hosts:\n  gitlab.example.com:\n    token: glpat-selfmanaged\n"
    expect(parseGlabToken(yaml)).toBeUndefined()
  })

  it("reads a self-hosted host's token when that host is passed", () => {
    const yaml =
      "hosts:\n" +
      "  gitlab.com:\n" +
      "    token: glpat-saas\n" +
      "  gitlab.example.com:\n" +
      "    token: !!null glpat-selfmanaged\n"
    expect(parseGlabToken(yaml, "gitlab.example.com")).toBe("glpat-selfmanaged")
    // gitlab.com is still the default.
    expect(parseGlabToken(yaml)).toBe("glpat-saas")
  })

  it("returns undefined for empty or malformed content", () => {
    expect(parseGlabToken("")).toBeUndefined()
    expect(parseGlabToken("not: [valid")).toBeUndefined()
  })
})

describe("detectConfigCredentials", () => {
  const configYml =
    "host: gitlab.com\n" +
    "hosts:\n" +
    "  gitlab.com:\n" +
    "    token: !!null glpat-from_config\n" +
    "    user: tester\n"

  it("reads the gitlab.com token from the legacy ~/.config path", async () => {
    const home = "/home/tester"
    const layer = Layer.merge(
      makeTestFileSystem({
        [`${home}/.config/glab-cli/config.yml`]: configYml,
      }),
      makeTestEnvironment({ HOME: home }),
    )

    const result = await Effect.runPromise(
      detectConfigCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBe("glpat-from_config")
  })

  it("reads a self-hosted host's token when that host is passed", async () => {
    const home = "/home/tester"
    const layer = Layer.merge(
      makeTestFileSystem({
        [`${home}/.config/glab-cli/config.yml`]:
          "hosts:\n" +
          "  gitlab.com:\n" +
          "    token: glpat-saas\n" +
          "  gitlab.example.com:\n" +
          "    token: glpat-selfmanaged\n",
      }),
      makeTestEnvironment({ HOME: home }),
    )

    const result = await Effect.runPromise(
      detectConfigCredentials("gitlab.example.com").pipe(Effect.provide(layer)),
    )
    expect(result).toBe("glpat-selfmanaged")
  })

  it("honors a GLAB_CONFIG_DIR override", async () => {
    const layer = Layer.merge(
      makeTestFileSystem({ "/custom/glab/config.yml": configYml }),
      makeTestEnvironment({ HOME: "/home/tester", GLAB_CONFIG_DIR: "/custom/glab" }),
    )

    const result = await Effect.runPromise(
      detectConfigCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBe("glpat-from_config")
  })

  it("returns undefined when no config file exists", async () => {
    const layer = Layer.merge(
      makeTestFileSystem({}),
      makeTestEnvironment({ HOME: "/home/tester" }),
    )

    const result = await Effect.runPromise(
      detectConfigCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })

  it("returns undefined when the config has no gitlab.com token", async () => {
    const home = "/home/tester"
    const layer = Layer.merge(
      makeTestFileSystem({
        [`${home}/.config/glab-cli/config.yml`]:
          "hosts:\n  gitlab.example.com:\n    token: glpat-selfmanaged\n",
      }),
      makeTestEnvironment({ HOME: home }),
    )

    const result = await Effect.runPromise(
      detectConfigCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })
})

// A config like the one `glab` writes for a user logged into gitlab.com (OAuth)
// and a self-managed instance (PAT) at the same time.
const multiHostYml =
  "host: gitlab.com\n" +
  "hosts:\n" +
  "  gitlab.com:\n" +
  "    token: !!null oauthdotcom0000\n" +
  '    is_oauth2: "true"\n' +
  "    user: odgrim\n" +
  "  gitlab.gruntwork.io:\n" +
  "    token: glpat-selfmanaged\n" +
  "    api_host: gitlab.gruntwork.io\n" +
  "    user: root\n"

describe("parseGlabToken (multi-host)", () => {
  it("reads the requested host's token, not just gitlab.com", () => {
    expect(parseGlabToken(multiHostYml, "gitlab.gruntwork.io")).toBe("glpat-selfmanaged")
  })

  it("defaults to gitlab.com when no host is given", () => {
    expect(parseGlabToken(multiHostYml)).toBe("oauthdotcom0000")
  })

  it("returns undefined for a host not present in the config", () => {
    expect(parseGlabToken(multiHostYml, "gitlab.absent.io")).toBeUndefined()
  })
})

describe("enumerateGlabHosts", () => {
  it("lists every host and reports glab's declared default", () => {
    expect(enumerateGlabHosts(multiHostYml)).toEqual({
      hosts: ["gitlab.com", "gitlab.gruntwork.io"],
      defaultHost: "gitlab.com",
    })
  })

  it("falls back to the first host when the declared default is absent", () => {
    const yaml =
      "host: gitlab.absent.io\n" +
      "hosts:\n  gitlab.gruntwork.io:\n    token: glpat-x\n"
    expect(enumerateGlabHosts(yaml)).toEqual({
      hosts: ["gitlab.gruntwork.io"],
      defaultHost: "gitlab.gruntwork.io",
    })
  })

  it("returns an empty list and the gitlab.com default for empty/malformed content", () => {
    expect(enumerateGlabHosts("")).toEqual({ hosts: [], defaultHost: "gitlab.com" })
    expect(enumerateGlabHosts("not: [valid")).toEqual({ hosts: [], defaultHost: "gitlab.com" })
  })
})

describe("detectConfigCredentials (multi-host)", () => {
  it("reads a self-managed host's token from the config file", async () => {
    const home = "/home/tester"
    const layer = Layer.merge(
      makeTestFileSystem({
        [`${home}/.config/glab-cli/config.yml`]: multiHostYml,
      }),
      makeTestEnvironment({ HOME: home }),
    )

    const result = await Effect.runPromise(
      detectConfigCredentials("gitlab.gruntwork.io").pipe(Effect.provide(layer)),
    )
    expect(result).toBe("glpat-selfmanaged")
  })
})

describe("detectConfigHosts", () => {
  it("enumerates hosts and the default from the first glab config found", async () => {
    const home = "/home/tester"
    const layer = Layer.merge(
      makeTestFileSystem({
        [`${home}/.config/glab-cli/config.yml`]: multiHostYml,
      }),
      makeTestEnvironment({ HOME: home }),
    )

    const result = await Effect.runPromise(
      detectConfigHosts().pipe(Effect.provide(layer)),
    )
    expect(result).toEqual({
      hosts: ["gitlab.com", "gitlab.gruntwork.io"],
      defaultHost: "gitlab.com",
    })
  })

  it("returns an empty list with the gitlab.com default when no glab config exists", async () => {
    const layer = Layer.merge(
      makeTestFileSystem({}),
      makeTestEnvironment({ HOME: "/home/tester" }),
    )

    const result = await Effect.runPromise(
      detectConfigHosts().pipe(Effect.provide(layer)),
    )
    expect(result).toEqual({ hosts: [], defaultHost: "gitlab.com" })
  })
})

// The credential-exfiltration guard moved to the §2.2 binding rule:
// <GitAuth host="attacker.example"/> must NOT cause the env GITLAB_TOKEN to
// be sent there — and (tightened vs the old gate) neither must a glab-config
// host that is not the env token's bound host. See "envTokenHost" above.

describe("readGlabHostMeta", () => {
  const yaml = `hosts:
    gitlab.com:
        token: !!null abc123
        is_oauth2: "true"
        oauth2_expiry_date: 2030-01-02 15:04:05 -0700 MST
    git.corp.example:
        token: glpat-pat
        ca_cert: /etc/ssl/corp-ca.pem
    keyringhost.example:
        use_keyring: true
`

  it("reads is_oauth2 + expiry for an OAuth host (tolerating !!null tags)", () => {
    const meta = readGlabHostMeta(yaml, "gitlab.com")
    expect(meta.isOAuth2).toBe(true)
    expect(meta.oauth2ExpiryDate).toBeInstanceOf(Date)
    expect(meta.oauth2ExpiryDate!.toISOString()).toBe("2030-01-02T22:04:05.000Z")
    expect(meta.caCert).toBeUndefined()
    expect(meta.useKeyring).toBe(false)
  })

  it("reads ca_cert for a PAT host", () => {
    const meta = readGlabHostMeta(yaml, "git.corp.example")
    expect(meta).toEqual({
      isOAuth2: false,
      oauth2ExpiryDate: undefined,
      caCert: "/etc/ssl/corp-ca.pem",
      useKeyring: false,
    })
  })

  it("reads the use_keyring marker", () => {
    expect(readGlabHostMeta(yaml, "keyringhost.example").useKeyring).toBe(true)
  })

  it("returns inert defaults for unknown hosts and malformed yaml", () => {
    expect(readGlabHostMeta(yaml, "missing.example")).toEqual({
      isOAuth2: false,
      oauth2ExpiryDate: undefined,
      caCert: undefined,
      useKeyring: false,
    })
    expect(readGlabHostMeta(":::not yaml [", "gitlab.com").isOAuth2).toBe(false)
  })
})

describe("parseGlabExpiry", () => {
  it("parses Go's default time format (zone name dropped, offset kept)", () => {
    expect(parseGlabExpiry("2024-08-08 19:22:11.804742 -0500 CDT")!.toISOString()).toBe(
      "2024-08-09T00:22:11.000Z",
    )
  })

  it("parses without fractional seconds and without zone name", () => {
    expect(parseGlabExpiry("2024-08-08 19:22:11 -0500")!.toISOString()).toBe(
      "2024-08-09T00:22:11.000Z",
    )
  })

  it("parses RFC3339", () => {
    expect(parseGlabExpiry("2024-08-09T00:22:11Z")!.toISOString()).toBe("2024-08-09T00:22:11.000Z")
  })

  it("returns undefined for garbage", () => {
    expect(parseGlabExpiry("not a date")).toBeUndefined()
    expect(parseGlabExpiry("")).toBeUndefined()
    expect(parseGlabExpiry(42)).toBeUndefined()
    expect(parseGlabExpiry(undefined)).toBeUndefined()
  })
})

describe("readGlabTokenForHost — OAuth staleness (§2.2, fake clock)", () => {
  const HOST = "stale.example.com"
  const configWith = (expiry: string) => `hosts:
    ${HOST}:
        token: !!null oauth-old-token
        is_oauth2: "true"
        oauth2_expiry_date: ${expiry}
`
  const fsLayer = (expiry: string) =>
    makeTestFileSystem({ "/home/u/.config/glab-cli/config.yml": configWith(expiry) })
  const envLayer = makeTestEnvironment({ HOME: "/home/u" })

  it("fresh token: reads directly, no glab auth status spawn", async () => {
    const { layer, calls } = makeRecordingSpawner(() => ({
      lines: [{ line: "oauth-old-token", source: "stdout" }],
      exitCode: 0,
    }))
    const now = () => new Date("2030-01-01T00:00:00Z") // well before expiry
    const result = await Effect.runPromise(
      readGlabTokenForHost(HOST, now).pipe(
        Effect.provide(Layer.mergeAll(layer, envLayer, fsLayer("2030-06-01 00:00:00 +0000"))),
      ),
    )
    expect(result).toEqual({ kind: "token", token: "oauth-old-token" })
    expect(calls.map((c) => c.args[0])).toEqual(["config"])
  })

  it("stale token (expires within 60s): refreshes via `glab auth status`, then re-reads", async () => {
    const { layer, calls } = makeRecordingSpawner((_cmd, args) =>
      args[0] === "auth"
        ? { lines: [{ line: "✓ Logged in to stale.example.com", source: "stderr" }], exitCode: 0 }
        : { lines: [{ line: "oauth-refreshed-token", source: "stdout" }], exitCode: 0 },
    )
    const now = () => new Date("2030-05-31T23:59:30Z") // 30s before expiry
    const result = await Effect.runPromise(
      readGlabTokenForHost(HOST, now).pipe(
        Effect.provide(Layer.mergeAll(layer, envLayer, fsLayer("2030-06-01 00:00:00 +0000"))),
      ),
    )
    expect(result).toEqual({ kind: "token", token: "oauth-refreshed-token" })
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["auth", "status"],
      ["config", "get"],
    ])
    expect(calls[0].args).toEqual(["auth", "status", "--hostname", HOST])
  })

  it("stale token + failed refresh: degrades to oauth-stale (exact remediation copy is the caller's)", async () => {
    const { layer } = makeRecordingSpawner((_cmd, args) =>
      args[0] === "auth"
        ? { lines: [{ line: "API call failed: dial tcp: timeout", source: "stderr" }], exitCode: 1 }
        : { lines: [{ line: "oauth-old-token", source: "stdout" }], exitCode: 0 },
    )
    const now = () => new Date("2030-06-01T01:00:00Z") // already expired
    const result = await Effect.runPromise(
      readGlabTokenForHost(HOST, now).pipe(
        Effect.provide(Layer.mergeAll(layer, envLayer, fsLayer("2030-06-01 00:00:00 +0000"))),
      ),
    )
    expect(result).toEqual({ kind: "oauth-stale" })
  })

  it("non-OAuth host: never consults glab auth status regardless of clock", async () => {
    const { layer, calls } = makeRecordingSpawner(() => ({
      lines: [{ line: "glpat-pat-token", source: "stdout" }],
      exitCode: 0,
    }))
    const fsPat = makeTestFileSystem({
      "/home/u/.config/glab-cli/config.yml": `hosts:\n    ${HOST}:\n        token: glpat-pat-token\n`,
    })
    const result = await Effect.runPromise(
      readGlabTokenForHost(HOST, () => new Date("2099-01-01T00:00:00Z")).pipe(
        Effect.provide(Layer.mergeAll(layer, envLayer, fsPat)),
      ),
    )
    expect(result).toEqual({ kind: "token", token: "glpat-pat-token" })
    expect(calls.every((c) => c.args[0] === "config")).toBe(true)
  })
})

describe("detectHostMeta / collectGlabCaCertPems (§3.1 harvest)", () => {
  const PEM = "-----BEGIN CERTIFICATE-----\nFAKECORPCA\n-----END CERTIFICATE-----\n"
  const config = `hosts:
    gitlab.com:
        token: glpat-a
    git.corp.example:
        token: glpat-b
        ca_cert: /etc/ssl/corp-ca.pem
    broken.example:
        ca_cert: /etc/ssl/missing.pem
`

  it("detectHostMeta finds the host's meta in the first config defining it", async () => {
    const layer = Layer.merge(
      makeTestEnvironment({ HOME: "/home/u" }),
      makeTestFileSystem({ "/home/u/.config/glab-cli/config.yml": config }),
    )
    const meta = await Effect.runPromise(
      detectHostMeta("git.corp.example").pipe(Effect.provide(layer)),
    )
    expect(meta?.caCert).toBe("/etc/ssl/corp-ca.pem")

    const missing = await Effect.runPromise(
      detectHostMeta("not-configured.example").pipe(Effect.provide(layer)),
    )
    expect(missing).toBeUndefined()
  })

  it("collects readable ca_cert PEM contents and skips unreadable/non-PEM files", async () => {
    const layer = Layer.merge(
      makeTestEnvironment({ HOME: "/home/u" }),
      makeTestFileSystem({
        "/home/u/.config/glab-cli/config.yml": config,
        "/etc/ssl/corp-ca.pem": PEM,
        // /etc/ssl/missing.pem deliberately absent
      }),
    )
    const pems = await Effect.runPromise(collectGlabCaCertPems().pipe(Effect.provide(layer)))
    expect(pems).toEqual([PEM])
  })

  it("returns an empty list when no glab config exists", async () => {
    const layer = Layer.merge(
      makeTestEnvironment({ HOME: "/home/u" }),
      makeTestFileSystem({}),
    )
    const pems = await Effect.runPromise(collectGlabCaCertPems().pipe(Effect.provide(layer)))
    expect(pems).toEqual([])
  })
})
