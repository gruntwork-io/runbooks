import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import {
  detectTokenType,
  detectEnvCredentials,
  detectCliCredentials,
  detectHostsYmlCredentials,
  parseGhCliScopes,
  parseGhHostsToken,
  resolveGhHostsPath,
  ENV_PREFIX_PATTERN,
} from "./auth.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { makeTestSpawner, makeRecordingSpawner } from "../../test-utils/TestSpawner.ts"
import { makeTestFileSystem } from "../../test-utils/TestFileSystem.ts"
import { Layer } from "effect"

describe("detectTokenType", () => {
  it("identifies classic PAT", () => {
    expect(detectTokenType("ghp_abc123")).toBe("classic_pat")
  })

  it("identifies fine-grained PAT", () => {
    expect(detectTokenType("github_pat_abc123")).toBe("fine_grained_pat")
  })

  it("identifies OAuth token", () => {
    expect(detectTokenType("gho_abc123")).toBe("oauth")
  })

  it("identifies GitHub App installation token", () => {
    expect(detectTokenType("ghs_abc123")).toBe("github_app")
  })

  it("identifies GitHub App user-to-server token", () => {
    expect(detectTokenType("ghu_abc123")).toBe("github_app")
  })

  it("returns unknown for unrecognized prefix", () => {
    expect(detectTokenType("random_token")).toBe("unknown")
  })

  it("returns unknown for empty string", () => {
    expect(detectTokenType("")).toBe("unknown")
  })
})

describe("detectEnvCredentials", () => {
  // Precedence GITHUB_TOKEN > GH_TOKEN is the golang-tested order
  // (beta-v0.9.0 api/remote_token_test.go) — gh itself prefers GH_TOKEN, the
  // divergence is made visible via shadowedVar instead of flipped.
  it("returns GITHUB_TOKEN when set", async () => {
    const layer = makeTestEnvironment({ GITHUB_TOKEN: "ghp_test123" })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toEqual({ token: "ghp_test123", envVar: "GITHUB_TOKEN", shadowedVar: undefined })
  })

  it("falls back to GH_TOKEN when GITHUB_TOKEN is missing", async () => {
    const layer = makeTestEnvironment({ GH_TOKEN: "gho_fallback" })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toEqual({ token: "gho_fallback", envVar: "GH_TOKEN" })
  })

  it("prefers GITHUB_TOKEN over GH_TOKEN (golang parity) and flags the shadowed var", async () => {
    const layer = makeTestEnvironment({
      GITHUB_TOKEN: "ghp_primary",
      GH_TOKEN: "gho_secondary",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result?.token).toBe("ghp_primary")
    expect(result?.envVar).toBe("GITHUB_TOKEN")
    // §2.1 both-set-and-differ: otherwise-silent shadowing becomes visible.
    expect(result?.shadowedVar).toBe("GH_TOKEN")
  })

  it("does not flag shadowing when both vars hold the SAME token", async () => {
    const layer = makeTestEnvironment({
      GITHUB_TOKEN: "ghp_same",
      GH_TOKEN: "ghp_same",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result?.shadowedVar).toBeUndefined()
  })

  it("returns undefined when neither is set", async () => {
    const layer = makeTestEnvironment({})
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })
})

describe("detectEnvCredentials — {env:{prefix}} variant (§2.1)", () => {
  it("looks up <PREFIX>GITHUB_TOKEN then <PREFIX>GH_TOKEN", async () => {
    const layer = makeTestEnvironment({
      MYAPP_GH_TOKEN: "gho_prefixed",
      GITHUB_TOKEN: "ghp_ambient",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials("MYAPP_").pipe(Effect.provide(layer)),
    )
    expect(result).toEqual({ token: "gho_prefixed", envVar: "MYAPP_GH_TOKEN" })
  })

  it("prefers <PREFIX>GITHUB_TOKEN over <PREFIX>GH_TOKEN", async () => {
    const layer = makeTestEnvironment({
      MYAPP_GITHUB_TOKEN: "ghp_first",
      MYAPP_GH_TOKEN: "gho_second",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials("MYAPP_").pipe(Effect.provide(layer)),
    )
    expect(result?.envVar).toBe("MYAPP_GITHUB_TOKEN")
  })

  it("never falls back to the unprefixed vars", async () => {
    const layer = makeTestEnvironment({ GITHUB_TOKEN: "ghp_ambient" })
    const result = await Effect.runPromise(
      detectEnvCredentials("MYAPP_").pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })

  it("treats an allowlist-violating prefix as absent (defense in depth)", async () => {
    const layer = makeTestEnvironment({ "lower_GITHUB_TOKEN": "ghp_x" })
    const result = await Effect.runPromise(
      detectEnvCredentials("lower_").pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })

  it("ENV_PREFIX_PATTERN allows uppercase snake prefixes ending in underscore only", () => {
    expect(ENV_PREFIX_PATTERN.test("MYAPP_")).toBe(true)
    expect(ENV_PREFIX_PATTERN.test("CI_BUILD2_")).toBe(true)
    expect(ENV_PREFIX_PATTERN.test("MYAPP")).toBe(false) // no trailing underscore
    expect(ENV_PREFIX_PATTERN.test("myapp_")).toBe(false) // lowercase
    expect(ENV_PREFIX_PATTERN.test("1APP_")).toBe(false) // leading digit
    expect(ENV_PREFIX_PATTERN.test("A B_")).toBe(false) // whitespace
    expect(ENV_PREFIX_PATTERN.test("")).toBe(false)
  })
})

describe("detectCliCredentials", () => {
  it("pins the read to github.com and strips ambient tokens from the child env", async () => {
    const { layer, calls } = makeRecordingSpawner(() => ({
      lines: [{ line: "ghp_cli_token", source: "stdout" }],
      exitCode: 0,
    }))
    const env = makeTestEnvironment({
      GITHUB_TOKEN: "ghp_ambient",
      GH_TOKEN: "gho_ambient",
      PATH: "/usr/bin",
    })

    const result = await Effect.runPromise(
      detectCliCredentials().pipe(Effect.provide(Layer.merge(layer, env))),
    )

    expect(result).toBe("ghp_cli_token")
    expect(calls).toHaveLength(1)
    // §2.1: the --hostname pin is deterministic for multi-host gh configs and
    // neutralizes GH_HOST.
    expect(calls[0].args).toEqual(["auth", "token", "--hostname", "github.com"])
    // Child-env hygiene: ambient tokens stripped (the CLI is a distinct
    // source, not an echo of env sources); kill switches set; PATH inherited.
    expect(calls[0].env).toBeDefined()
    expect(calls[0].env!.GITHUB_TOKEN).toBeUndefined()
    expect(calls[0].env!.GH_TOKEN).toBeUndefined()
    expect(calls[0].env!.GH_PROMPT_DISABLED).toBe("1")
    expect(calls[0].env!.GH_NO_UPDATE_NOTIFIER).toBe("1")
    expect(calls[0].env!.NO_COLOR).toBe("1")
    expect(calls[0].env!.PATH).toBe("/usr/bin")
  })

  it("returns undefined when command fails", async () => {
    const layer = Layer.merge(
      makeTestSpawner([{
        command: "gh",
        args: ["auth", "token", "--hostname", "github.com"],
        outputLines: [],
        exitCode: 1,
      }]),
      makeTestEnvironment(),
    )

    const result = await Effect.runPromise(
      detectCliCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })
})

describe("parseGhCliScopes (golang parity matrix)", () => {
  const cases: Array<{ name: string; input: string; expected: string[] | undefined }> = [
    {
      name: "standard output with multiple scopes",
      input: `github.com
  ✓ Logged in to github.com account josh-padnick (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'`,
      expected: ["gist", "read:org", "repo", "workflow"],
    },
    {
      name: "single scope",
      input: `github.com
  ✓ Logged in to github.com account user (keyring)
  - Token scopes: 'repo'`,
      expected: ["repo"],
    },
    {
      name: "scopes without quotes",
      input: `github.com
  - Token scopes: repo, gist, read:org`,
      expected: ["repo", "gist", "read:org"],
    },
    {
      name: "singular Token scope (no s)",
      input: `github.com
  - Token scope: 'repo'`,
      expected: ["repo"],
    },
    {
      name: "no scopes line returns undefined",
      input: `github.com
  ✓ Logged in to github.com account user (keyring)
  - Active account: true`,
      expected: undefined,
    },
    { name: "empty input returns undefined", input: "", expected: undefined },
    {
      name: "scopes with double quotes",
      input: `github.com
  - Token scopes: "repo", "gist"`,
      expected: ["repo", "gist"],
    },
    {
      name: "mixed quotes",
      input: `github.com
  - Token scopes: 'repo', "gist", read:org`,
      expected: ["repo", "gist", "read:org"],
    },
    {
      name: "scopes with extra whitespace",
      input: `github.com
  - Token scopes:   'repo'  ,  'gist'  ,  'workflow'  `,
      expected: ["repo", "gist", "workflow"],
    },
  ]

  for (const tc of cases) {
    it(tc.name, () => {
      expect(parseGhCliScopes(tc.input)).toEqual(tc.expected)
    })
  }
})

describe("gh hosts.yml fallback (§2.1 #3b)", () => {
  it("resolves EXACTLY ONE path in gh's order: GH_CONFIG_DIR > XDG_CONFIG_HOME/gh > ~/.config/gh", () => {
    // gh uses a single config directory — no fall-through: a set
    // GH_CONFIG_DIR with no hosts.yml means "no gh config", never a peek at
    // ~/.config/gh (which would leak another profile's credentials).
    expect(
      resolveGhHostsPath({ env: { GH_CONFIG_DIR: "/custom/gh", XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" } }),
    ).toBe("/custom/gh/hosts.yml")
    expect(resolveGhHostsPath({ env: { XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" } })).toBe("/xdg/gh/hosts.yml")
    expect(resolveGhHostsPath({ env: { HOME: "/home/u" } })).toBe("/home/u/.config/gh/hosts.yml")
    expect(resolveGhHostsPath({ env: {} })).toBeUndefined()
  })

  it("never falls through past a set GH_CONFIG_DIR with no hosts.yml", async () => {
    const layer = Layer.merge(
      makeTestEnvironment({ GH_CONFIG_DIR: "/empty/gh", HOME: "/home/u" }),
      makeTestFileSystem({
        "/home/u/.config/gh/hosts.yml": `github.com:\n    oauth_token: gho_other_profile\n`,
      }),
    )
    const result = await Effect.runPromise(
      detectHostsYmlCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toEqual({ entryExists: false })
  })

  it("parses the github.com oauth_token", () => {
    const yaml = `github.com:\n    oauth_token: gho_disk_token\n    user: someone\n`
    expect(parseGhHostsToken(yaml)).toEqual({ entryExists: true, token: "gho_disk_token" })
  })

  it("reports an entry with no token (gh keyring storage)", () => {
    const yaml = `github.com:\n    user: someone\n    git_protocol: https\n`
    expect(parseGhHostsToken(yaml)).toEqual({ entryExists: true, token: undefined })
  })

  it("reports a missing github.com entry", () => {
    expect(parseGhHostsToken(`ghes.corp.example:\n    oauth_token: x\n`)).toEqual({
      entryExists: false,
    })
    expect(parseGhHostsToken("")).toEqual({ entryExists: false })
  })

  it("reads the resolved hosts.yml's github.com entry", async () => {
    const layer = Layer.merge(
      makeTestEnvironment({ HOME: "/home/u" }),
      makeTestFileSystem({
        "/home/u/.config/gh/hosts.yml": `github.com:\n    oauth_token: gho_from_disk\n`,
      }),
    )
    const result = await Effect.runPromise(
      detectHostsYmlCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toEqual({ entryExists: true, token: "gho_from_disk" })
  })

  it("returns entryExists false when no hosts.yml exists", async () => {
    const layer = Layer.merge(makeTestEnvironment({ HOME: "/home/u" }), makeTestFileSystem({}))
    const result = await Effect.runPromise(
      detectHostsYmlCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toEqual({ entryExists: false })
  })
})
