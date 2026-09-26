/**
 * GitHub Enterprise (GHES / ghe.com) host handling in the GitHub auth domain:
 * env-token host binding, multi-host hosts.yml, OAuth client selection and
 * the session-env credential contract.
 */
import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import {
  DEFAULT_GITHUB_OAUTH_CLIENT_ID,
  configuredGhHost,
  detectCliCredentials,
  detectEnvCredentials,
  detectGhConfigHosts,
  detectHostsYmlCredentials,
  githubEnvBindings,
  githubEnvCredentialForHost,
  githubEnvTokenVarsForHost,
  githubSessionCredential,
  githubSessionEnv,
  oauthUnavailableMessage,
  parseGhHosts,
  parseGhHostsToken,
  resolveOAuthClientId,
} from "./auth.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { makeTestFileSystem } from "../../test-utils/TestFileSystem.ts"
import { makeRecordingSpawner } from "../../test-utils/TestSpawner.ts"
import { Layer } from "effect"

const GHES = "ghes.example.com"
const GHEC = "acme.ghe.com"

// ---------------------------------------------------------------------------
// Env binding
// ---------------------------------------------------------------------------

describe("githubEnvBindings", () => {
  it("no GH_HOST → standard tokens bound to github.com, no enterprise binding", () => {
    expect(githubEnvBindings({})).toEqual({ standard: "github.com" })
    // blank counts as unset
    expect(githubEnvBindings({ GH_HOST: "  " })).toEqual({ standard: "github.com" })
  })

  it("GH_HOST=github.com → standard github.com", () => {
    expect(githubEnvBindings({ GH_HOST: "github.com" })).toEqual({ standard: "github.com" })
  })

  it("GH_HOST=<ghe.com tenant> → standard tokens bound to the tenant only", () => {
    expect(githubEnvBindings({ GH_HOST: GHEC })).toEqual({ standard: GHEC })
    expect(githubEnvBindings({ GH_HOST: "https://ACME.ghe.com/" })).toEqual({ standard: GHEC })
  })

  it("GH_HOST=<GHES> → standard github.com + enterprise GHES", () => {
    expect(githubEnvBindings({ GH_HOST: GHES })).toEqual({ standard: "github.com", enterprise: GHES })
    expect(githubEnvBindings({ GH_HOST: "GHES.example.com:8443" })).toEqual({
      standard: "github.com",
      enterprise: "ghes.example.com:8443",
    })
  })

  it("an unparseable GH_HOST binds NOTHING (never falls back to github.com)", () => {
    expect(githubEnvBindings({ GH_HOST: "ftp://ghes.example.com" })).toEqual({})
    expect(githubEnvBindings({ GH_HOST: "https://u:p@ghes.example.com" })).toEqual({})
    expect(githubEnvBindings({ GH_HOST: "not a host" })).toEqual({})
  })

  it("the prefixed variant is bound by <PREFIX>GH_HOST, never by GH_HOST", () => {
    expect(githubEnvBindings({ GH_HOST: GHES }, "MYAPP_")).toEqual({ standard: "github.com" })
    expect(githubEnvBindings({ MYAPP_GH_HOST: GHES }, "MYAPP_")).toEqual({
      standard: "github.com",
      enterprise: GHES,
    })
    expect(githubEnvBindings({ MYAPP_GH_HOST: GHEC }, "MYAPP_")).toEqual({ standard: GHEC })
    expect(githubEnvBindings({ MYAPP_GH_HOST: "ftp://x" }, "MYAPP_")).toEqual({})
    // ...and the unprefixed binding ignores <PREFIX>GH_HOST
    expect(githubEnvBindings({ MYAPP_GH_HOST: GHES })).toEqual({ standard: "github.com" })
  })

  it("configuredGhHost returns the raw value (prefix-aware), blank as unset", () => {
    expect(configuredGhHost({ GH_HOST: "GHES.example.com" })).toBe("GHES.example.com")
    expect(configuredGhHost({ GH_HOST: "" })).toBeUndefined()
    expect(configuredGhHost({ GH_HOST: GHES }, "MYAPP_")).toBeUndefined()
    expect(configuredGhHost({ MYAPP_GH_HOST: GHES }, "MYAPP_")).toBe(GHES)
  })
})

describe("githubEnvTokenVarsForHost / githubEnvCredentialForHost — scoping matrix", () => {
  const ALL = {
    GITHUB_TOKEN: "ghp_dotcom",
    GH_TOKEN: "gho_dotcom2",
    GH_ENTERPRISE_TOKEN: "ghp_enterprise",
    GITHUB_ENTERPRISE_TOKEN: "ghp_enterprise2",
  }

  it("no GH_HOST: GITHUB_TOKEN only for github.com; enterprise tokens bound nowhere", () => {
    expect(githubEnvTokenVarsForHost("github.com", ALL)).toEqual(["GITHUB_TOKEN", "GH_TOKEN"])
    expect(githubEnvTokenVarsForHost(GHES, ALL)).toEqual([])
    expect(githubEnvTokenVarsForHost(GHEC, ALL)).toEqual([])
    expect(githubEnvCredentialForHost("github.com", ALL)?.token).toBe("ghp_dotcom")
    expect(githubEnvCredentialForHost(GHES, ALL)).toBeUndefined()
    expect(githubEnvCredentialForHost(GHEC, ALL)).toBeUndefined()
  })

  it("GH_HOST=GHES: GH_ENTERPRISE_TOKEN only for that GHES host; GITHUB_TOKEN still github.com only", () => {
    const env = { ...ALL, GH_HOST: GHES }
    expect(githubEnvTokenVarsForHost(GHES, env)).toEqual(["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"])
    expect(githubEnvCredentialForHost(GHES, env)).toEqual({ token: "ghp_enterprise", envVar: "GH_ENTERPRISE_TOKEN" })
    // never GITHUB_TOKEN for a GHES host
    expect(githubEnvCredentialForHost(GHES, { GITHUB_TOKEN: "ghp_dotcom", GH_HOST: GHES })).toBeUndefined()
    // never GH_ENTERPRISE_TOKEN for github.com
    expect(githubEnvCredentialForHost("github.com", env)?.envVar).toBe("GITHUB_TOKEN")
    expect(
      githubEnvCredentialForHost("github.com", { GH_ENTERPRISE_TOKEN: "ghp_enterprise", GH_HOST: GHES }),
    ).toBeUndefined()
    // never to a DIFFERENT GHES host (no harvesting via an authored host)
    expect(githubEnvCredentialForHost("other-ghes.example.com", env)).toBeUndefined()
    // nor to a ghe.com tenant
    expect(githubEnvCredentialForHost(GHEC, env)).toBeUndefined()
  })

  it("GITHUB_ENTERPRISE_TOKEN is the fallback for the GHES host (gh's order)", () => {
    const env = { GH_HOST: GHES, GITHUB_ENTERPRISE_TOKEN: "ghp_e2" }
    expect(githubEnvCredentialForHost(GHES, env)).toEqual({ token: "ghp_e2", envVar: "GITHUB_ENTERPRISE_TOKEN" })
    // no GITHUB_TOKEN/GH_TOKEN divergence hint on the enterprise pair
    const both = { GH_HOST: GHES, GH_ENTERPRISE_TOKEN: "a", GITHUB_ENTERPRISE_TOKEN: "b" }
    expect(githubEnvCredentialForHost(GHES, both)).toEqual({ token: "a", envVar: "GH_ENTERPRISE_TOKEN" })
  })

  it("GH_HOST=<ghe.com>: GITHUB_TOKEN only for that tenant, NOT github.com", () => {
    const env = { ...ALL, GH_HOST: GHEC }
    expect(githubEnvCredentialForHost(GHEC, env)?.token).toBe("ghp_dotcom")
    expect(githubEnvCredentialForHost("github.com", env)).toBeUndefined()
    // another tenant gets nothing
    expect(githubEnvCredentialForHost("other.ghe.com", env)).toBeUndefined()
    // enterprise tokens are never bound for a ghe.com GH_HOST
    expect(githubEnvCredentialForHost(GHEC, { GH_HOST: GHEC, GH_ENTERPRISE_TOKEN: "e" })).toBeUndefined()
  })

  it("the target host is normalized (case, URL form, api. origin)", () => {
    const env = { GH_HOST: GHES, GH_ENTERPRISE_TOKEN: "e", GITHUB_TOKEN: "d" }
    expect(githubEnvCredentialForHost("https://GHES.example.com/o/r", env)?.token).toBe("e")
    expect(githubEnvCredentialForHost("api.github.com", env)?.token).toBe("d")
  })

  it("an unparseable GH_HOST binds nothing — not even github.com", () => {
    const env = { ...ALL, GH_HOST: "ftp://ghes.example.com" }
    expect(githubEnvTokenVarsForHost("github.com", env)).toEqual([])
    expect(githubEnvCredentialForHost("github.com", env)).toBeUndefined()
    expect(githubEnvCredentialForHost(GHES, env)).toBeUndefined()
  })

  it("an unparseable target host yields nothing", () => {
    expect(githubEnvTokenVarsForHost("", ALL)).toEqual([])
    expect(githubEnvTokenVarsForHost("https://u:p@github.com", ALL)).toEqual([])
  })

  it("an invalid prefix yields no names", () => {
    expect(githubEnvTokenVarsForHost("github.com", ALL, "bad-prefix")).toEqual([])
    expect(githubEnvTokenVarsForHost("github.com", ALL, "NOUNDERSCORE")).toEqual([])
  })

  describe("prefix variant (bound by <PREFIX>GH_HOST)", () => {
    it("without <PREFIX>GH_HOST, <PREFIX>GITHUB_TOKEN binds to github.com only", () => {
      const env = { MYAPP_GITHUB_TOKEN: "p_dotcom", MYAPP_GH_ENTERPRISE_TOKEN: "p_ent" }
      expect(githubEnvTokenVarsForHost("github.com", env, "MYAPP_")).toEqual([
        "MYAPP_GITHUB_TOKEN",
        "MYAPP_GH_TOKEN",
      ])
      expect(githubEnvCredentialForHost("github.com", env, "MYAPP_")).toEqual({
        token: "p_dotcom",
        envVar: "MYAPP_GITHUB_TOKEN",
      })
      expect(githubEnvCredentialForHost(GHES, env, "MYAPP_")).toBeUndefined()
    })

    it("<PREFIX>GH_HOST=GHES binds <PREFIX>GH_ENTERPRISE_TOKEN to that host", () => {
      const env = {
        MYAPP_GH_HOST: GHES,
        MYAPP_GH_ENTERPRISE_TOKEN: "p_ent",
        MYAPP_GITHUB_TOKEN: "p_dotcom",
      }
      expect(githubEnvTokenVarsForHost(GHES, env, "MYAPP_")).toEqual([
        "MYAPP_GH_ENTERPRISE_TOKEN",
        "MYAPP_GITHUB_ENTERPRISE_TOKEN",
      ])
      expect(githubEnvCredentialForHost(GHES, env, "MYAPP_")).toEqual({
        token: "p_ent",
        envVar: "MYAPP_GH_ENTERPRISE_TOKEN",
      })
      // never the prefixed github.com token for the GHES host, nor the reverse
      expect(githubEnvCredentialForHost("github.com", env, "MYAPP_")?.token).toBe("p_dotcom")
      expect(
        githubEnvCredentialForHost(GHES, { MYAPP_GH_HOST: GHES, MYAPP_GITHUB_TOKEN: "p_dotcom" }, "MYAPP_"),
      ).toBeUndefined()
    })

    it("the unprefixed GH_HOST does NOT bind prefixed tokens", () => {
      const env = { GH_HOST: GHES, MYAPP_GH_ENTERPRISE_TOKEN: "p_ent", MYAPP_GITHUB_TOKEN: "p_dotcom" }
      expect(githubEnvCredentialForHost(GHES, env, "MYAPP_")).toBeUndefined()
      expect(githubEnvCredentialForHost("github.com", env, "MYAPP_")?.token).toBe("p_dotcom")
    })

    it("<PREFIX>GH_HOST=<ghe.com> binds <PREFIX>GITHUB_TOKEN to the tenant, not github.com", () => {
      const env = { MYAPP_GH_HOST: GHEC, MYAPP_GITHUB_TOKEN: "p" }
      expect(githubEnvCredentialForHost(GHEC, env, "MYAPP_")?.token).toBe("p")
      expect(githubEnvCredentialForHost("github.com", env, "MYAPP_")).toBeUndefined()
    })

    it("<PREFIX>GH_HOST does not affect unprefixed tokens", () => {
      const env = { MYAPP_GH_HOST: GHEC, GITHUB_TOKEN: "d" }
      expect(githubEnvCredentialForHost("github.com", env)?.token).toBe("d")
      expect(githubEnvCredentialForHost(GHEC, env)).toBeUndefined()
    })

    it("an unparseable <PREFIX>GH_HOST binds no prefixed token", () => {
      const env = { MYAPP_GH_HOST: "ftp://x", MYAPP_GITHUB_TOKEN: "p" }
      expect(githubEnvCredentialForHost("github.com", env, "MYAPP_")).toBeUndefined()
    })

    it("never shadow-flags the prefixed pair", () => {
      const env = { MYAPP_GITHUB_TOKEN: "a", MYAPP_GH_TOKEN: "b" }
      expect(githubEnvCredentialForHost("github.com", env, "MYAPP_")?.shadowedVar).toBeUndefined()
    })
  })
})

describe("detectEnvCredentials(host, prefix)", () => {
  const run = (env: Record<string, string>, host?: string, prefix?: string) =>
    Effect.runPromise(detectEnvCredentials(host, prefix).pipe(Effect.provide(makeTestEnvironment(env))))

  it("defaults to github.com", async () => {
    expect((await run({ GITHUB_TOKEN: "d", GH_HOST: GHES, GH_ENTERPRISE_TOKEN: "e" }))?.token).toBe("d")
  })

  it("GHES host: only GH_ENTERPRISE_TOKEN bound by GH_HOST", async () => {
    expect(await run({ GITHUB_TOKEN: "d" }, GHES)).toBeUndefined()
    expect(await run({ GITHUB_TOKEN: "d", GH_ENTERPRISE_TOKEN: "e" }, GHES)).toBeUndefined()
    expect((await run({ GITHUB_TOKEN: "d", GH_ENTERPRISE_TOKEN: "e", GH_HOST: GHES }, GHES))?.token).toBe("e")
  })

  it("ghe.com host: GITHUB_TOKEN only when GH_HOST names the tenant", async () => {
    expect(await run({ GITHUB_TOKEN: "d" }, GHEC)).toBeUndefined()
    expect((await run({ GITHUB_TOKEN: "d", GH_HOST: GHEC }, GHEC))?.token).toBe("d")
  })

  it("prefix variant follows <PREFIX>GH_HOST", async () => {
    const env = { MYAPP_GH_HOST: GHES, MYAPP_GH_ENTERPRISE_TOKEN: "p_ent", GH_ENTERPRISE_TOKEN: "ambient" }
    expect(await run(env, GHES, "MYAPP_")).toEqual({ token: "p_ent", envVar: "MYAPP_GH_ENTERPRISE_TOKEN" })
    expect(await run({ GH_HOST: GHES, MYAPP_GH_ENTERPRISE_TOKEN: "p_ent" }, GHES, "MYAPP_")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// gh CLI (per host)
// ---------------------------------------------------------------------------

describe("detectCliCredentials(host)", () => {
  it("pins --hostname to the requested host and strips every token/host env var", async () => {
    const spawner = makeRecordingSpawner(() => ({
      lines: [{ line: "ghp_from_gh", source: "stdout" }],
      exitCode: 0,
    }))
    const layer = Layer.mergeAll(
      spawner.layer,
      makeTestEnvironment({
        GH_HOST: "elsewhere.example.com",
        GH_TOKEN: "x",
        GITHUB_TOKEN: "y",
        GH_ENTERPRISE_TOKEN: "z",
        GITHUB_ENTERPRISE_TOKEN: "w",
      }),
    )
    const token = await Effect.runPromise(detectCliCredentials(GHES).pipe(Effect.provide(layer)))
    expect(token).toBe("ghp_from_gh")
    expect(spawner.calls[0].args).toEqual(["auth", "token", "--hostname", GHES])
    const env = spawner.calls[0].env!
    for (const name of ["GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
      expect(env[name]).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// hosts.yml (multi-host)
// ---------------------------------------------------------------------------

const MULTI_HOST_YML = `
github.com:
    user: octocat
    oauth_token: gho_dotcom
    git_protocol: https
GHES.Example.com:
    user: alice
    oauth_token: ghp_ghes
acme.ghe.com:
    git_protocol: https
    user: bob
    users:
        bob:
            oauth_token: gho_tenant
        carol:
            oauth_token: gho_carol
keyring.example.com:
    user: dave
    git_protocol: https
`

describe("parseGhHosts", () => {
  it("lists every host (github.com + GHES + ghe.com), normalized", () => {
    expect(parseGhHosts(MULTI_HOST_YML).sort()).toEqual(
      ["acme.ghe.com", "ghes.example.com", "github.com", "keyring.example.com"].sort(),
    )
  })

  it("dedupes keys that normalize to the same host", () => {
    expect(parseGhHosts("github.com:\n  user: a\nGitHub.com:\n  user: b\n")).toEqual(["github.com"])
  })

  it("skips keys that are not parseable hosts", () => {
    expect(parseGhHosts("github.com:\n  user: a\n'ftp://bad':\n  user: b\n'u:p@x':\n  user: c\n")).toEqual([
      "github.com",
    ])
  })

  it("is empty for invalid / non-mapping YAML", () => {
    expect(parseGhHosts("")).toEqual([])
    expect(parseGhHosts("- a\n- b\n")).toEqual([])
    expect(parseGhHosts(":\n  - [unclosed")).toEqual([])
  })
})

describe("parseGhHostsToken (per host)", () => {
  it("reads each host's own oauth_token", () => {
    expect(parseGhHostsToken(MULTI_HOST_YML)).toEqual({ entryExists: true, token: "gho_dotcom" })
    expect(parseGhHostsToken(MULTI_HOST_YML, "github.com")).toEqual({ entryExists: true, token: "gho_dotcom" })
  })

  it("matches the key case-insensitively / by normalized form", () => {
    expect(parseGhHostsToken(MULTI_HOST_YML, "ghes.example.com")).toEqual({ entryExists: true, token: "ghp_ghes" })
    expect(parseGhHostsToken(MULTI_HOST_YML, "https://GHES.EXAMPLE.COM/o/r")).toEqual({
      entryExists: true,
      token: "ghp_ghes",
    })
  })

  it("falls back to the gh ≥ 2.40 `users:` layout for the ACTIVE user", () => {
    expect(parseGhHostsToken(MULTI_HOST_YML, "acme.ghe.com")).toEqual({ entryExists: true, token: "gho_tenant" })
    // api.<sub>.ghe.com normalizes to the tenant
    expect(parseGhHostsToken(MULTI_HOST_YML, "api.acme.ghe.com").token).toBe("gho_tenant")
  })

  it("top-level oauth_token wins over the users: layout", () => {
    const yml = "github.com:\n  user: a\n  oauth_token: top\n  users:\n    a:\n      oauth_token: nested\n"
    expect(parseGhHostsToken(yml).token).toBe("top")
  })

  it("users: without a matching active user yields no token (entry still exists)", () => {
    const yml = "github.com:\n  users:\n    a:\n      oauth_token: nested\n"
    expect(parseGhHostsToken(yml)).toEqual({ entryExists: true })
  })

  it("a keyring entry without a token → entryExists true, no token", () => {
    expect(parseGhHostsToken(MULTI_HOST_YML, "keyring.example.com")).toEqual({ entryExists: true })
    expect(parseGhHostsToken("github.com:\n", "github.com")).toEqual({ entryExists: true })
  })

  it("a host not in the file → entryExists false (never another host's token)", () => {
    expect(parseGhHostsToken(MULTI_HOST_YML, "other.example.com")).toEqual({ entryExists: false })
    expect(parseGhHostsToken("ghes.example.com:\n  oauth_token: t\n", "github.com")).toEqual({ entryExists: false })
  })

  it("an unparseable target host → entryExists false", () => {
    expect(parseGhHostsToken(MULTI_HOST_YML, "ftp://github.com")).toEqual({ entryExists: false })
  })
})

describe("detectHostsYmlCredentials / detectGhConfigHosts", () => {
  const layer = Layer.mergeAll(
    makeTestEnvironment({ GH_CONFIG_DIR: "/cfg/gh" }),
    makeTestFileSystem({ "/cfg/gh/hosts.yml": MULTI_HOST_YML }),
  )

  it("reads the requested host's entry from hosts.yml", async () => {
    const ghes = await Effect.runPromise(detectHostsYmlCredentials(GHES).pipe(Effect.provide(layer)))
    expect(ghes).toEqual({ entryExists: true, token: "ghp_ghes" })
    const dotcom = await Effect.runPromise(detectHostsYmlCredentials().pipe(Effect.provide(layer)))
    expect(dotcom.token).toBe("gho_dotcom")
  })

  it("lists all configured hosts", async () => {
    const hosts = await Effect.runPromise(detectGhConfigHosts().pipe(Effect.provide(layer)))
    expect(hosts).toContain("ghes.example.com")
    expect(hosts).toContain("acme.ghe.com")
    expect(hosts).toContain("github.com")
  })

  it("no hosts.yml → no hosts, no entry", async () => {
    const empty = Layer.mergeAll(makeTestEnvironment({ GH_CONFIG_DIR: "/none" }), makeTestFileSystem({}))
    expect(await Effect.runPromise(detectGhConfigHosts().pipe(Effect.provide(empty)))).toEqual([])
    expect(await Effect.runPromise(detectHostsYmlCredentials(GHES).pipe(Effect.provide(empty)))).toEqual({
      entryExists: false,
    })
  })
})

// ---------------------------------------------------------------------------
// OAuth client ID
// ---------------------------------------------------------------------------

describe("resolveOAuthClientId", () => {
  it("github.com falls back to the Gruntwork default", () => {
    expect(resolveOAuthClientId("github.com")).toBe(DEFAULT_GITHUB_OAUTH_CLIENT_ID)
    expect(resolveOAuthClientId("github.com", "")).toBe(DEFAULT_GITHUB_OAUTH_CLIENT_ID)
    expect(resolveOAuthClientId("github.com", "   ")).toBe(DEFAULT_GITHUB_OAUTH_CLIENT_ID)
    expect(resolveOAuthClientId("github.com", "Iv1.custom")).toBe("Iv1.custom")
  })

  it("an enterprise host gets ONLY a configured client ID — never the github.com default", () => {
    expect(resolveOAuthClientId(GHES)).toBeUndefined()
    expect(resolveOAuthClientId(GHES, "  ")).toBeUndefined()
    expect(resolveOAuthClientId(GHEC)).toBeUndefined()
    expect(resolveOAuthClientId(GHES, "Iv1.ghes")).toBe("Iv1.ghes")
    expect(resolveOAuthClientId(GHEC, " Iv1.ghec ")).toBe("Iv1.ghec")
  })

  it("oauthUnavailableMessage names the host and the alternatives", () => {
    const msg = oauthUnavailableMessage(GHES)
    expect(msg).toContain(GHES)
    expect(msg).toContain(`gh auth login --hostname ${GHES}`)
    expect(msg.toLowerCase()).toContain("personal access token")
  })
})

// ---------------------------------------------------------------------------
// Session env
// ---------------------------------------------------------------------------

describe("githubSessionEnv", () => {
  it("github.com: token, user, host vars; no GH_ENTERPRISE_TOKEN", () => {
    expect(githubSessionEnv("github.com", "t", "octocat")).toEqual({
      GITHUB_TOKEN: "t",
      GITHUB_USER: "octocat",
      GITHUB_HOST: "github.com",
      GH_HOST: "github.com",
    })
  })

  it("ghe.com: no GH_ENTERPRISE_TOKEN (gh reads GH_TOKEN/GITHUB_TOKEN for tenants)", () => {
    const env = githubSessionEnv(GHEC, "t", "bob")
    expect(env.GITHUB_HOST).toBe(GHEC)
    expect(env.GH_HOST).toBe(GHEC)
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined()
  })

  it("GHES: also writes GH_ENTERPRISE_TOKEN", () => {
    expect(githubSessionEnv(GHES, "t", "alice")).toEqual({
      GITHUB_TOKEN: "t",
      GITHUB_USER: "alice",
      GITHUB_HOST: GHES,
      GH_HOST: GHES,
      GH_ENTERPRISE_TOKEN: "t",
    })
  })

  it("omits GITHUB_USER without a login", () => {
    expect("GITHUB_USER" in githubSessionEnv("github.com", "t")).toBe(false)
  })
})

describe("githubSessionCredential", () => {
  it("auth-host binding: releases the session token for that host only", () => {
    const env = { ...githubSessionEnv(GHES, "t_ghes", "alice") }
    expect(githubSessionCredential(env, GHES, GHES)).toEqual({ token: "t_ghes", host: GHES })
    expect(githubSessionCredential(env, "https://GHES.example.com/o/r", GHES)).toEqual({
      token: "t_ghes",
      host: GHES,
    })
    expect(githubSessionCredential(env, "github.com", GHES)).toBeUndefined()
    expect(githubSessionCredential(env, GHEC, GHES)).toBeUndefined()
    expect(githubSessionCredential(env, "other-ghes.example.com", GHES)).toBeUndefined()
  })

  it("auth-host binding for a ghe.com tenant never serves github.com", () => {
    const env = githubSessionEnv(GHEC, "t_ghec")
    expect(githubSessionCredential(env, GHEC, GHEC)).toEqual({ token: "t_ghec", host: GHEC })
    expect(githubSessionCredential(env, "github.com", GHEC)).toBeUndefined()
  })

  it("auth-host binding for github.com never serves an enterprise host", () => {
    const env = githubSessionEnv("github.com", "t_dotcom")
    expect(githubSessionCredential(env, "github.com", "github.com")?.token).toBe("t_dotcom")
    expect(githubSessionCredential(env, GHES, "github.com")).toBeUndefined()
  })

  it("host undefined → the auth block's host", () => {
    const env = githubSessionEnv(GHES, "t_ghes")
    expect(githubSessionCredential(env, undefined, GHES)).toEqual({ token: "t_ghes", host: GHES })
  })

  it("releases nothing when env GITHUB_HOST no longer matches the auth host (fail closed)", () => {
    // A script changed or removed GITHUB_HOST while the auth block's token may
    // still be in GITHUB_TOKEN: reinterpreting it with gh's conventions could
    // send a GHES token to github.com, so nothing is released for any host.
    const env = { GITHUB_TOKEN: "t_ghes", GH_HOST: GHES }
    expect(githubSessionCredential(env, GHES, GHES)).toBeUndefined()
    expect(githubSessionCredential(env, "github.com", GHES)).toBeUndefined()
    expect(githubSessionCredential(env, undefined, GHES)).toBeUndefined()
    // a GITHUB_HOST for a DIFFERENT host doesn't bind either
    expect(
      githubSessionCredential({ GITHUB_TOKEN: "x", GITHUB_HOST: "github.com" }, GHES, GHES),
    ).toBeUndefined()
  })

  it("without an auth host, uses the gh env binding (GH_ENTERPRISE_TOKEN for the GH_HOST GHES)", () => {
    const env = { GITHUB_TOKEN: "d", GH_ENTERPRISE_TOKEN: "e", GH_HOST: GHES }
    expect(githubSessionCredential(env, GHES)).toEqual({ token: "e", host: GHES })
    expect(githubSessionCredential(env, "github.com")).toEqual({ token: "d", host: "github.com" })
    expect(githubSessionCredential({ GITHUB_TOKEN: "d" }, GHES)).toBeUndefined()
    expect(githubSessionCredential({ GITHUB_TOKEN: "d" }, GHEC)).toBeUndefined()
    expect(githubSessionCredential({ GITHUB_TOKEN: "d", GH_HOST: GHEC }, GHEC)).toEqual({ token: "d", host: GHEC })
  })

  it("default host selection without an auth host: standard binding first, then enterprise, else github.com", () => {
    // standard binding has a token → it wins
    expect(githubSessionCredential({ GITHUB_TOKEN: "d", GH_ENTERPRISE_TOKEN: "e", GH_HOST: GHES }, undefined)).toEqual({
      token: "d",
      host: "github.com",
    })
    // only the enterprise token → the GHES host
    expect(githubSessionCredential({ GH_ENTERPRISE_TOKEN: "e", GH_HOST: GHES }, undefined)).toEqual({
      token: "e",
      host: GHES,
    })
    // ghe.com GH_HOST → the tenant
    expect(githubSessionCredential({ GH_TOKEN: "t", GH_HOST: GHEC }, undefined)).toEqual({ token: "t", host: GHEC })
    // nothing → undefined (default github.com has no token)
    expect(githubSessionCredential({}, undefined)).toBeUndefined()
  })

  it("an unparseable requested host → undefined, never github.com", () => {
    const env = githubSessionEnv("github.com", "t")
    expect(githubSessionCredential(env, "ftp://github.com", "github.com")).toBeUndefined()
    expect(githubSessionCredential({ GITHUB_TOKEN: "t" }, "https://u:p@github.com")).toBeUndefined()
  })

  it("an unparseable GH_HOST in the session env binds nothing", () => {
    expect(githubSessionCredential({ GITHUB_TOKEN: "t", GH_HOST: "not a host" }, "github.com")).toBeUndefined()
    expect(githubSessionCredential({ GITHUB_TOKEN: "t", GH_HOST: "not a host" }, undefined)).toBeUndefined()
  })
})
