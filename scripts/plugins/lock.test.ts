import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { readPluginsLock } from "@runbooks/platform-node/layers/PluginsLock"
import { type Context, EXIT, LIMITS, main } from "./lock.ts"

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const RELEASES = "/gruntwork-io/runbooks-plugins/releases"
const CHECKED_IN = path.resolve(import.meta.dirname, "../../resources/plugins.lock")

/** A binary's bytes, different for each plugin, platform and version. */
const binary = (plugin: string, platform: string, version = "0.1.0") =>
  `#!/bin/sh\necho ${plugin} ${platform} ${version}\n`

/** What a release names a binary, written out as the release does. */
const asset = (plugin: string, platform: string, version = "0.1.0") => {
  const [os, arch] = platform.split("-")
  return `runbooks-credential-${plugin}_${version}_${os}_${arch}${os === "windows" ? ".exe" : ""}`
}

const PLUGINS = ["aws", "google"] as const
const PLATFORMS = ["darwin-arm64", "linux-amd64", "windows-amd64"] as const

let root = ""
let bin = ""
let lockFile = ""
let routes = new Map<string, () => Response>()
let requests: Array<string> = []
let server: ReturnType<typeof Bun.serve> | undefined
let out: Array<string> = []
let err: Array<string> = []

const writeLock = (plugins: ReadonlyArray<string> = PLUGINS, version = "0.1.0") =>
  writeFileSync(
    lockFile,
    JSON.stringify({
      plugins: plugins.map((name) => ({
        name,
        kind: "credential",
        version,
        sha256: Object.fromEntries(
          PLATFORMS.map((platform) => [platform, sha256(binary(name, platform, version))]),
        ),
      })),
    }),
  )

/** Serves every binary of `version` for `platforms`, as its release does. */
const serveBinaries = (version = "0.1.0", platforms: ReadonlyArray<string> = PLATFORMS) => {
  for (const plugin of PLUGINS) {
    for (const platform of platforms) {
      serve(
        `${RELEASES}/download/v${version}/${asset(plugin, platform, version)}`,
        binary(plugin, platform, version),
      )
    }
  }
}

const serve = (pathname: string, body: string | (() => Response)) =>
  routes.set(pathname, typeof body === "string" ? () => new Response(body) : body)

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "runbooks-plugins-recipes-"))
  bin = path.join(root, "resources", "bin")
  lockFile = path.join(root, "resources", "plugins.lock")
  mkdirSync(path.dirname(lockFile), { recursive: true })
  writeLock()
  routes = new Map()
  requests = []
  out = []
  err = []
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url)
      requests.push(pathname)
      return routes.get(pathname)?.() ?? new Response("Not Found", { status: 404 })
    },
  })
})
afterEach(async () => {
  await server?.stop(true)
  rmSync(root, { recursive: true, force: true })
})

const context = (overrides: Partial<Context> = {}): Context => {
  const base = server?.url.origin ?? ""
  return {
    root,
    releases: { download: base, api: base },
    limits: LIMITS,
    host: { platform: "darwin", arch: "arm64" },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...overrides,
  }
}

const run = (args: ReadonlyArray<string>, overrides: Partial<Context> = {}) =>
  main(args, context(overrides))

const installed = () => (existsSync(bin) ? readdirSync(bin).sort() : [])
const staging = () =>
  readdirSync(path.dirname(bin)).filter((file) => file.startsWith(".plugins-download-"))
const stderr = () => err.join("\n")

describe("fetch", () => {
  it("installs each binary the lock pins for the host's platform, mode 755, and prints its hash", async () => {
    serveBinaries()
    expect(await run(["fetch"])).toBe(EXIT.ok)
    expect(installed()).toEqual(["runbooks-credential-aws", "runbooks-credential-google"])
    for (const plugin of PLUGINS) {
      const file = path.join(bin, `runbooks-credential-${plugin}`)
      expect(readFileSync(file, "utf8")).toBe(binary(plugin, "darwin-arm64"))
      expect(statSync(file).mode & 0o777).toBe(0o755)
    }
    expect(out).toEqual(
      PLUGINS.map(
        (plugin) => `${sha256(binary(plugin, "darwin-arm64"))}  runbooks-credential-${plugin}`,
      ),
    )
    expect(requests).toEqual(
      PLUGINS.map((plugin) => `${RELEASES}/download/v0.1.0/${asset(plugin, "darwin-arm64")}`),
    )
    expect(staging()).toEqual([])
  })

  it("fetches another platform's binaries with --platform, as .exe for Windows", async () => {
    serveBinaries()
    expect(await run(["fetch", "--platform", "windows-amd64"])).toBe(EXIT.ok)
    expect(installed()).toEqual(["runbooks-credential-aws.exe", "runbooks-credential-google.exe"])
    expect(readFileSync(path.join(bin, "runbooks-credential-aws.exe"), "utf8")).toBe(
      binary("aws", "windows-amd64"),
    )
    expect(requests).toContain(
      `${RELEASES}/download/v0.1.0/runbooks-credential-aws_0.1.0_windows_amd64.exe`,
    )
  })

  it("on a mismatch, prints the asset, the expected hash and the actual one, and moves nothing in", async () => {
    serveBinaries()
    serve(`${RELEASES}/download/v0.1.0/${asset("google", "darwin-arm64")}`, "not google")
    expect(await run(["fetch"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain(`${asset("google", "darwin-arm64")}: SHA-256 mismatch`)
    expect(stderr()).toContain(`expected ${sha256(binary("google", "darwin-arm64"))}`)
    expect(stderr()).toContain(`actual   ${sha256("not google")}`)
    expect(installed()).toEqual([])
    expect(out).toEqual([])
    expect(staging()).toEqual([])
  })

  it("fails on a missing asset, naming it, and moves nothing in", async () => {
    serveBinaries()
    routes.delete(`${RELEASES}/download/v0.1.0/${asset("aws", "darwin-arm64")}`)
    expect(await run(["fetch"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain(`${asset("aws", "darwin-arm64")}: HTTP 404`)
    expect(installed()).toEqual([])
    expect(staging()).toEqual([])
  })

  it("stops a download past the size limit, even one the lock pins, and moves nothing in", async () => {
    const limit = 64
    const big = "x".repeat(limit + 1)
    writeFileSync(
      lockFile,
      JSON.stringify({
        plugins: [
          {
            name: "aws",
            kind: "credential",
            version: "0.1.0",
            sha256: { "darwin-arm64": sha256(big) },
          },
        ],
      }),
    )
    // Streamed, so no Content-Length says how big it is.
    serve(
      `${RELEASES}/download/v0.1.0/${asset("aws", "darwin-arm64")}`,
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(big.slice(0, 40)))
              controller.enqueue(new TextEncoder().encode(big.slice(40)))
              controller.close()
            },
          }),
        ),
    )
    const limits = { ...LIMITS, binaryBytes: limit }
    expect(await run(["fetch"], { limits })).toBe(EXIT.mismatch)
    expect(stderr()).toContain(`${asset("aws", "darwin-arm64")}: larger than ${limit} bytes`)
    expect(installed()).toEqual([])
    expect(staging()).toEqual([])

    expect(await run(["fetch"], { limits: { ...LIMITS, binaryBytes: limit + 1 } })).toBe(EXIT.ok)
    expect(installed()).toEqual(["runbooks-credential-aws"])
  })

  it("refuses a platform the contract does not know, before any request", async () => {
    serveBinaries()
    expect(await run(["fetch", "--platform", "freebsd-amd64"])).toBe(EXIT.usage)
    expect(stderr()).toContain('--platform "freebsd-amd64" is not a platform')
    expect(stderr()).toContain(
      "darwin-arm64, darwin-amd64, linux-arm64, linux-amd64, windows-amd64",
    )
    expect(requests).toEqual([])
  })

  it("asks for --platform on a host no plugin is built for", async () => {
    expect(await run(["fetch"], { host: { platform: "freebsd", arch: "x64" } })).toBe(EXIT.usage)
    expect(stderr()).toContain("pass --platform")
    expect(requests).toEqual([])
  })

  it("fails for a platform the lock has no hashes for, before any request", async () => {
    serveBinaries("0.1.0", ["linux-arm64"])
    expect(await run(["fetch", "--platform", "linux-arm64"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain("has no linux-arm64 hash for credential aws, credential google")
    expect(requests).toEqual([])
    expect(installed()).toEqual([])
  })

  it("replaces a binary already there only with one that matches", async () => {
    const aws = path.join(bin, "runbooks-credential-aws")
    mkdirSync(bin)
    writeFileSync(aws, "an older aws")
    serveBinaries()
    serve(`${RELEASES}/download/v0.1.0/${asset("aws", "darwin-arm64")}`, "not aws either")
    expect(await run(["fetch"])).toBe(EXIT.mismatch)
    expect(readFileSync(aws, "utf8")).toBe("an older aws")

    serveBinaries()
    expect(await run(["fetch"])).toBe(EXIT.ok)
    expect(readFileSync(aws, "utf8")).toBe(binary("aws", "darwin-arm64"))
    expect(statSync(aws).mode & 0o777).toBe(0o755)
  })

  it("downloads nothing for a binary already there with its pinned hash, and makes it executable", async () => {
    serveBinaries()
    expect(await run(["fetch"])).toBe(EXIT.ok)
    const aws = path.join(bin, "runbooks-credential-aws")
    chmodSync(aws, 0o644)
    requests = []
    out = []
    expect(await run(["fetch"])).toBe(EXIT.ok)
    expect(requests).toEqual([])
    expect(statSync(aws).mode & 0o777).toBe(0o755)
    expect(out).toHaveLength(2)
  })

  it("removes plugin binaries the lock does not pin for the platform, and leaves other files", async () => {
    mkdirSync(bin)
    for (const file of [
      "runbooks-credential-old",
      "runbooks-credential-aws.exe",
      "runbooks-test",
      "boilerplate",
    ]) {
      writeFileSync(path.join(bin, file), file)
    }
    serveBinaries()
    expect(await run(["fetch"])).toBe(EXIT.ok)
    expect(installed()).toEqual([
      "boilerplate",
      "runbooks-credential-aws",
      "runbooks-credential-google",
      "runbooks-test",
    ])
    expect(stderr()).toContain("removed resources/bin/runbooks-credential-old")
  })

  it("treats a lock that is not valid as a usage error, naming the lock", async () => {
    writeFileSync(lockFile, '{"plugins": [{"name": "aws"}]}')
    expect(await run(["fetch"])).toBe(EXIT.usage)
    expect(stderr()).toContain(`${lockFile}: `)
    expect(stderr()).toContain('["plugins"][0]["kind"]')
    expect(requests).toEqual([])
  })
})

describe("check", () => {
  const fetched = async (platform = "darwin-arm64") => {
    serveBinaries()
    expect(await run(["fetch", "--platform", platform])).toBe(EXIT.ok)
    out = []
    err = []
  }

  it("passes on what fetch installed, and prints the hashes", async () => {
    await fetched()
    expect(await run(["check"])).toBe(EXIT.ok)
    expect(out).toEqual(
      PLUGINS.map(
        (plugin) => `${sha256(binary(plugin, "darwin-arm64"))}  runbooks-credential-${plugin}`,
      ),
    )
    expect(err).toEqual([])
  })

  it("names a plugin binary the lock does not pin, and ignores other files", async () => {
    await fetched()
    writeFileSync(path.join(bin, "runbooks-credential-extra"), "extra")
    writeFileSync(path.join(bin, "runbooks-test"), "the test CLI")
    expect(await run(["check"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain(
      "resources/bin/runbooks-credential-extra: resources/plugins.lock pins no such darwin-arm64 binary",
    )
    expect(stderr()).not.toContain("runbooks-test")
  })

  it("names a binary whose hash is not the pinned one, with both hashes", async () => {
    await fetched()
    writeFileSync(path.join(bin, "runbooks-credential-google"), "swapped")
    expect(await run(["check"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain("resources/bin/runbooks-credential-google: SHA-256 mismatch")
    expect(stderr()).toContain(`expected ${sha256(binary("google", "darwin-arm64"))}`)
    expect(stderr()).toContain(`actual   ${sha256("swapped")}`)
  })

  it("names a binary that is missing, and one that is not executable", async () => {
    await fetched()
    rmSync(path.join(bin, "runbooks-credential-aws"))
    chmodSync(path.join(bin, "runbooks-credential-google"), 0o644)
    expect(await run(["check"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain("resources/bin/runbooks-credential-aws: missing")
    expect(stderr()).toContain("resources/bin/runbooks-credential-google: not executable")
  })

  it("names a binary for another platform", async () => {
    await fetched("linux-amd64")
    expect(await run(["check", "--platform", "darwin-arm64"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain("resources/bin/runbooks-credential-aws: SHA-256 mismatch")
  })

  it("checks another folder with --bin-dir, as the packaged app's", async () => {
    await fetched()
    const packaged = path.join(
      root,
      "out",
      "mac-arm64",
      "Runbooks.app",
      "Contents",
      "Resources",
      "bin",
    )
    mkdirSync(packaged, { recursive: true })
    for (const file of installed()) copyFileSync(path.join(bin, file), path.join(packaged, file))
    for (const file of installed()) chmodSync(path.join(packaged, file), 0o755)
    expect(
      await run(["check", "--bin-dir", "out/mac-arm64/Runbooks.app/Contents/Resources/bin"]),
    ).toBe(EXIT.ok)

    writeFileSync(path.join(packaged, "runbooks-credential-aws"), "re-signed")
    expect(await run(["check", "--bin-dir", packaged])).toBe(EXIT.mismatch)
    expect(stderr()).toContain(
      "out/mac-arm64/Runbooks.app/Contents/Resources/bin/runbooks-credential-aws: SHA-256 mismatch",
    )
  })

  it("passes an empty folder for a platform the lock pins nothing for, and refuses a plugin binary there", async () => {
    mkdirSync(bin)
    expect(await run(["check", "--platform", "linux-arm64"])).toBe(EXIT.ok)
    writeFileSync(path.join(bin, "runbooks-credential-aws"), "aws")
    expect(await run(["check", "--platform", "linux-arm64"])).toBe(EXIT.mismatch)
  })
})

describe("bump", () => {
  /** A release of `version`: its binaries, `SHA256SUMS` and the API's answer, each changeable. */
  const release = (
    version: string,
    change: {
      readonly sums?: (lines: Array<string>) => Array<string>
      readonly assets?: (
        assets: Array<{ name: string; digest?: string | null }>,
      ) => Array<{ name: string; digest?: string | null }>
    } = {},
  ) => {
    const names = PLUGINS.flatMap((plugin) =>
      PLATFORMS.map(
        (platform) =>
          [asset(plugin, platform, version), binary(plugin, platform, version)] as const,
      ),
    )
    const lines = names.map(([name, bytes]) => `${sha256(bytes)}  ${name}`)
    const sums = `${(change.sums ?? ((all) => all))(lines).join("\n")}\n`
    const assets = (change.assets ?? ((all) => all))([
      ...names.map(([name, bytes]) => ({ name, digest: `sha256:${sha256(bytes)}` })),
      { name: "SHA256SUMS", digest: `sha256:${sha256(sums)}` },
    ])
    serve(`${RELEASES}/download/v${version}/SHA256SUMS`, sums)
    serve(`/repos/gruntwork-io/runbooks-plugins/releases/tags/v${version}`, () =>
      Response.json({ tag_name: `v${version}`, draft: false, assets }),
    )
  }

  const lockText = () => readFileSync(lockFile, "utf8")

  it("rewrites the lock from SHA256SUMS when the API's digests agree, and again to the same bytes", async () => {
    release("0.2.0")
    expect(await run(["bump", "v0.2.0"])).toBe(EXIT.ok)
    const plugins = await Effect.runPromise(readPluginsLock(lockFile))
    expect(plugins.map((plugin) => [plugin.kind, plugin.name, plugin.version])).toEqual([
      ["credential", "aws", "0.2.0"],
      ["credential", "google", "0.2.0"],
    ])
    for (const plugin of plugins) {
      expect<unknown>(plugin.sha256).toEqual(
        Object.fromEntries(
          PLATFORMS.map((platform) => [platform, sha256(binary(plugin.name, platform, "0.2.0"))]),
        ),
      )
    }
    expect(stderr()).toContain("wrote resources/plugins.lock: 2 plugins at 0.2.0")
    const first = lockText()
    expect(await run(["bump", "0.2.0"])).toBe(EXIT.ok)
    expect(lockText()).toBe(first)
  })

  it("writes the checked-in lock byte for byte from a release with its hashes", async () => {
    const checkedIn = readFileSync(CHECKED_IN, "utf8")
    const lock = await Effect.runPromise(readPluginsLock(CHECKED_IN))
    const version = lock[0]?.version ?? ""
    const names = lock.flatMap((plugin) =>
      Object.entries(plugin.sha256).map(([platform, hash]) => [
        `runbooks-${plugin.kind}-${plugin.name}_${plugin.version}_${platform.replace("-", "_")}${platform.startsWith("windows") ? ".exe" : ""}`,
        hash,
      ]),
    )
    serve(
      `${RELEASES}/download/v${version}/SHA256SUMS`,
      `${names.map(([name, hash]) => `${hash}  ${name}`).join("\n")}\n`,
    )
    serve(`/repos/gruntwork-io/runbooks-plugins/releases/tags/v${version}`, () =>
      Response.json({
        tag_name: `v${version}`,
        assets: names.map(([name, hash]) => ({ name, digest: `sha256:${hash}` })),
      }),
    )
    expect(await run(["bump", version])).toBe(EXIT.ok)
    expect(lockText()).toBe(checkedIn)
  })

  it("refuses a SHA256SUMS that disagrees with the API's digest, naming both, and leaves the lock", async () => {
    const before = lockText()
    const name = asset("aws", "linux-amd64", "0.2.0")
    release("0.2.0", {
      sums: (lines) =>
        lines.map((line) => (line.endsWith(`  ${name}`) ? `${"f".repeat(64)}  ${name}` : line)),
    })
    expect(await run(["bump", "0.2.0"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain(`${name}: SHA256SUMS and the API disagree`)
    expect(stderr()).toContain(`SHA256SUMS ${"f".repeat(64)}`)
    expect(stderr()).toContain(`API        sha256:${sha256(binary("aws", "linux-amd64", "0.2.0"))}`)
    expect(lockText()).toBe(before)
  })

  it("reports every problem with the release in one pass, and leaves the lock", async () => {
    const before = lockText()
    const noDigest = asset("aws", "darwin-arm64", "0.2.0")
    const notReleased = asset("google", "darwin-arm64", "0.2.0")
    const notSummed = asset("google", "linux-amd64", "0.2.0")
    release("0.2.0", {
      sums: (lines) => [...lines.filter((line) => !line.endsWith(notSummed)), "not a line"],
      assets: (assets) =>
        assets
          .filter((one) => one.name !== notReleased)
          .map((one) => (one.name === noDigest ? { name: one.name, digest: null } : one)),
    })
    expect(await run(["bump", "0.2.0"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain(`${noDigest}: the API gives no digest for it`)
    expect(stderr()).toContain(
      `${notReleased}: in SHA256SUMS but not in gruntwork-io/runbooks-plugins v0.2.0`,
    )
    expect(stderr()).toContain(
      `${notSummed}: in gruntwork-io/runbooks-plugins v0.2.0 but not in its SHA256SUMS`,
    )
    expect(stderr()).toContain(
      `SHA256SUMS line ${PLUGINS.length * PLATFORMS.length}: expected "<sha256>  <file>", got "not a line"`,
    )
    expect(lockText()).toBe(before)
  })

  it("skips a binary for a platform the app does not know, and says so", async () => {
    const freebsd = "runbooks-credential-aws_0.2.0_freebsd_amd64"
    const hash = sha256("freebsd aws")
    release("0.2.0", {
      sums: (lines) => [...lines, `${hash}  ${freebsd}`],
      assets: (assets) => [...assets, { name: freebsd, digest: `sha256:${hash}` }],
    })
    expect(await run(["bump", "0.2.0"])).toBe(EXIT.ok)
    expect(stderr()).toContain(`skipped ${freebsd}: the app knows no platform freebsd-amd64`)
    const plugins = await Effect.runPromise(readPluginsLock(lockFile))
    expect(Object.keys(plugins[0]?.sha256 ?? {})).toEqual([...PLATFORMS])
  })

  it("fails for a release that is not there, and for a SHA256SUMS past its limit", async () => {
    const before = lockText()
    expect(await run(["bump", "0.9.0"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain("gruntwork-io/runbooks-plugins v0.9.0: HTTP 404")

    release("0.2.0")
    expect(await run(["bump", "0.2.0"], { limits: { ...LIMITS, sumsBytes: 100 } })).toBe(
      EXIT.mismatch,
    )
    expect(stderr()).toContain("SHA256SUMS: larger than 100 bytes")
    expect(lockText()).toBe(before)
  })

  it("refuses a version that is not one, before any request", async () => {
    expect(await run(["bump", "latest"])).toBe(EXIT.usage)
    expect(stderr()).toContain('"latest" is not a version')
    expect(requests).toEqual([])
  })
})

describe("schemas", () => {
  const SCHEMAS = {
    "base.schema.json": '{"title":"base"}\n',
    "credential.schema.json": '{"title":"credential"}\n',
  }

  /** Writes `plugin/<file>` in the repo root for each schema given. */
  const writeSchemas = (schemas: Readonly<Record<string, string>>) => {
    mkdirSync(path.join(root, "plugin"), { recursive: true })
    for (const [file, text] of Object.entries(schemas))
      writeFileSync(path.join(root, "plugin", file), text)
  }

  /** Serves a release's SHA256SUMS: its binaries' lines, then one per schema, as plugins releases list them. */
  const serveSums = (schemas: Readonly<Record<string, string>>, version = "0.1.0") => {
    const lines = [
      ...PLUGINS.flatMap((plugin) =>
        PLATFORMS.map(
          (platform) =>
            `${sha256(binary(plugin, platform, version))}  ${asset(plugin, platform, version)}`,
        ),
      ),
      ...Object.entries(schemas).map(([file, text]) => `${sha256(text)}  ${file}`),
    ]
    serve(`${RELEASES}/download/v${version}/SHA256SUMS`, `${lines.join("\n")}\n`)
  }

  it("passes when plugin/ holds exactly the pinned release's schemas, byte for byte, and prints their hashes", async () => {
    writeSchemas(SCHEMAS)
    serveSums(SCHEMAS)
    expect(await run(["schemas"])).toBe(EXIT.ok)
    expect(out).toEqual(
      Object.entries(SCHEMAS).map(([file, text]) => `${sha256(text)}  plugin/${file}`),
    )
    expect(requests).toEqual([`${RELEASES}/download/v0.1.0/SHA256SUMS`])
  })

  it("names a schema whose bytes differ from the release's, with both hashes", async () => {
    const changed = { ...SCHEMAS, "credential.schema.json": '{"title":"credential, changed"}\n' }
    writeSchemas(changed)
    serveSums(SCHEMAS)
    expect(await run(["schemas"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain(
      `plugin/credential.schema.json, against gruntwork-io/runbooks-plugins v0.1.0: SHA-256 mismatch\n  expected ${sha256(SCHEMAS["credential.schema.json"])}\n  actual   ${sha256(changed["credential.schema.json"])}`,
    )
    expect(stderr()).not.toContain("base.schema.json")
    expect(out).toEqual([])
  })

  it("names a schema the release lists that plugin/ lacks, and one plugin/ holds that the release does not list", async () => {
    writeSchemas({ "base.schema.json": SCHEMAS["base.schema.json"], "driver.schema.json": "{}\n" })
    serveSums(SCHEMAS)
    expect(await run(["schemas"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain(
      "plugin/credential.schema.json: missing; gruntwork-io/runbooks-plugins v0.1.0 lists it",
    )
    expect(stderr()).toContain(
      "plugin/driver.schema.json: not in gruntwork-io/runbooks-plugins v0.1.0's SHA256SUMS",
    )
  })

  it("fails when the release's SHA256SUMS can't be read, or lists no schema", async () => {
    writeSchemas(SCHEMAS)
    expect(await run(["schemas"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain("gruntwork-io/runbooks-plugins v0.1.0 SHA256SUMS: ")
    err = []
    serveSums({})
    expect(await run(["schemas"])).toBe(EXIT.mismatch)
    expect(stderr()).toContain(
      "gruntwork-io/runbooks-plugins v0.1.0: its SHA256SUMS lists no schema",
    )
  })

  it("checks against every release the lock pins", async () => {
    writeFileSync(
      lockFile,
      JSON.stringify({
        plugins: [
          { name: "aws", kind: "credential", version: "0.1.0", sha256: {} },
          { name: "google", kind: "credential", version: "0.2.0", sha256: {} },
        ],
      }),
    )
    writeSchemas(SCHEMAS)
    serveSums(SCHEMAS, "0.1.0")
    serveSums({ ...SCHEMAS, "base.schema.json": '{"title":"base 0.2.0"}\n' }, "0.2.0")
    expect(await run(["schemas"])).toBe(EXIT.mismatch)
    expect(requests.sort()).toEqual([
      `${RELEASES}/download/v0.1.0/SHA256SUMS`,
      `${RELEASES}/download/v0.2.0/SHA256SUMS`,
    ])
    expect(stderr()).toContain(
      "plugin/base.schema.json, against gruntwork-io/runbooks-plugins v0.2.0: SHA-256 mismatch",
    )
    expect(stderr()).not.toContain("against gruntwork-io/runbooks-plugins v0.1.0")
  })
})

describe("usage", () => {
  it.each([
    [[]],
    [["install"]],
    [["fetch", "extra"]],
    [["fetch", "--bin-dir", "x"]],
    [["bump"]],
    [["check", "--color"]],
    [["schemas", "extra"]],
    [["schemas", "--platform", "linux-amd64"]],
  ])("refuses %j with the usage", async (args) => {
    expect(await run(args)).toBe(EXIT.usage)
    expect(stderr()).toContain("usage:")
    expect(requests).toEqual([])
  })
})
