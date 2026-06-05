import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import {
  detectTokenType,
  detectEnvCredentials,
  detectCliCredentials,
  detectConfigCredentials,
  resolveGlabConfigPaths,
  parseGlabToken,
} from "./auth.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { makeTestSpawner } from "../../test-utils/TestSpawner.ts"
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
    expect(result).toBe("glpat-test123")
  })

  it("returns undefined when GITLAB_TOKEN is not set", async () => {
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

describe("detectCliCredentials", () => {
  it("returns token from a successful `glab auth token`", async () => {
    const layer = Layer.merge(
      makeTestSpawner([{
        command: "glab",
        args: ["auth", "token"],
        outputLines: ["glpat-cli_token"],
        exitCode: 0,
      }]),
      makeTestEnvironment(),
    )

    const result = await Effect.runPromise(
      detectCliCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBe("glpat-cli_token")
  })

  it("returns undefined when the command fails", async () => {
    const layer = Layer.merge(
      makeTestSpawner([{
        command: "glab",
        args: ["auth", "token"],
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

  it("returns undefined when the CLI is not installed", async () => {
    // No expectation registered for `glab` → the spawner fails, mirroring a
    // missing binary.
    const layer = Layer.merge(makeTestSpawner([]), makeTestEnvironment())

    const result = await Effect.runPromise(
      detectCliCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
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
