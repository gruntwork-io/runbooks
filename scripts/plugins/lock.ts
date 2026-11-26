/**
 * The plugin recipes over `resources/plugins.lock`: `just fetch-plugins`,
 * `just check-plugins` and `just bump-plugins`.
 *
 *   bun scripts/plugins/lock.ts fetch [--platform <os>-<arch>]
 *   bun scripts/plugins/lock.ts check [--platform <os>-<arch>] [--bin-dir <dir>]
 *   bun scripts/plugins/lock.ts bump <version>
 *
 * - fetch: downloads each binary the lock pins for the platform (the host's
 *   by default) from its release into a temporary folder beside
 *   `resources/bin`, and checks its SHA-256. Only when every one matches are
 *   they moved into `resources/bin` under their installed names, mode 755.
 *   A binary already there with its pinned hash is not downloaded again,
 *   and plugin binaries the lock does not pin for the platform are removed.
 * - check: a bin folder (`--bin-dir`, relative to the repo root, or
 *   `resources/bin`) holds exactly the plugin binaries the lock pins for
 *   the platform, each with its pinned hash, and executable. That is all a
 *   release may bundle.
 * - bump: reads a release's `SHA256SUMS`, checks each line against the
 *   digest GitHub's API gives for that asset, and rewrites the lock with
 *   every plugin binary in it, at that version.
 *
 * fetch and check print `<sha256>  <file>` per binary on standard output,
 * the format `shasum -a 256 -c` reads. Problems go to standard error, all of
 * them in one pass.
 *
 * Exit codes: 0 done. 1 a binary, the release or the bin folder does not
 * match the lock, or a download failed; fetch and bump then change nothing.
 * 2 a usage error, or the lock is not valid.
 */
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { Effect, Exit, Option, Predicate, Schema } from "effect"
import { Platform, type PluginEntry, PluginKind } from "@runbooks/core/plugin/transport"
import { binaryName } from "@runbooks/platform-node/layers/NodePluginProcess"
import { PluginsLock, readPluginsLock } from "@runbooks/platform-node/layers/PluginsLock"

/** Every plugin is released from this one repo, all at one version (open decision 16). */
const REPO = "gruntwork-io/runbooks-plugins"
const LOCK_FILE = "resources/plugins.lock"
const BIN_DIR = "resources/bin"
/** Where fetch stages its downloads: beside `resources/bin`, on its filesystem, and outside what is bundled. */
const STAGING_PREFIX = ".plugins-download-"

export const EXIT = { ok: 0, mismatch: 1, usage: 2 } as const

export const LIMITS = {
  /** One binary. The largest in v0.1.0 is 20.8 MB. */
  binaryBytes: 64 * 1024 * 1024,
  /** A release's `SHA256SUMS`: one line per binary. */
  sumsBytes: 64 * 1024,
  /** The API's answer for one release. */
  releaseBytes: 1024 * 1024,
  /** One request, from sending it to the last byte of the answer. */
  requestMillis: 5 * 60_000,
}
type Limits = typeof LIMITS

export interface Context {
  /** The repo root: the lock is `<root>/resources/plugins.lock`. */
  readonly root: string
  /** Where releases are downloaded from (`https://github.com`) and described (`https://api.github.com`). */
  readonly releases: { readonly download: string; readonly api: string }
  readonly limits: Limits
  /** `process.platform` and `process.arch`, for the default platform. */
  readonly host: { readonly platform: string; readonly arch: string }
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

const USAGE = `usage:
  bun scripts/plugins/lock.ts fetch [--platform <os>-<arch>]
  bun scripts/plugins/lock.ts check [--platform <os>-<arch>] [--bin-dir <dir>]
  bun scripts/plugins/lock.ts bump <version>
--bin-dir is relative to the repo root; resources/bin when absent.
platforms: ${Platform.literals.join(", ")}`

class UsageError extends Error {}

export async function main(argv: ReadonlyArray<string>, context: Context): Promise<number> {
  try {
    return await run(argv, context)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    context.err(error.message)
    context.err(USAGE)
    return EXIT.usage
  }
}

async function run(argv: ReadonlyArray<string>, context: Context): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { platform: { type: "string" }, "bin-dir": { type: "string" } },
    })
  } catch (error) {
    throw new UsageError(messageOf(error))
  }
  const { values, positionals } = parsed
  const [command, ...rest] = positionals
  const refuse = (what: string) => {
    throw new UsageError(`${command} takes no ${what}`)
  }
  switch (command) {
    case "fetch":
      if (rest.length > 0) refuse("arguments")
      if (values["bin-dir"] !== undefined) refuse("--bin-dir")
      return fetchPlugins(
        context,
        await pinnedPlugins(context),
        platformOf(values.platform, context),
      )
    case "check": {
      if (rest.length > 0) refuse("arguments")
      const binDir = path.resolve(context.root, values["bin-dir"] ?? BIN_DIR)
      return checkPlugins(
        context,
        await pinnedPlugins(context),
        platformOf(values.platform, context),
        binDir,
      )
    }
    case "bump": {
      if (values.platform !== undefined) refuse("--platform")
      if (values["bin-dir"] !== undefined) refuse("--bin-dir")
      const [version, ...more] = rest
      if (version === undefined || more.length > 0) throw new UsageError("bump takes one version")
      return bump(context, versionOf(version))
    }
    case undefined:
      throw new UsageError("no command given")
    default:
      throw new UsageError(`${JSON.stringify(command)} is not a command`)
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const HOST_OS: Readonly<Record<string, string>> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
}
const HOST_ARCH: Readonly<Record<string, string>> = { arm64: "arm64", x64: "amd64" }

function platformOf(value: string | undefined, context: Context): Platform {
  const wanted =
    value ??
    `${HOST_OS[context.host.platform] ?? context.host.platform}-${HOST_ARCH[context.host.arch] ?? context.host.arch}`
  const platform = Schema.decodeUnknownOption(Platform)(wanted)
  if (Option.isSome(platform)) return platform.value
  throw new UsageError(
    value === undefined
      ? `this host (${context.host.platform} ${context.host.arch}) is no platform a plugin is built for: pass --platform`
      : `--platform ${JSON.stringify(value)} is not a platform`,
  )
}

function versionOf(value: string): string {
  const version = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(value)?.[1]
  if (version === undefined) {
    throw new UsageError(`${JSON.stringify(value)} is not a version: expected one like 0.2.0`)
  }
  return version
}

async function pinnedPlugins(context: Context): Promise<ReadonlyArray<PluginEntry>> {
  const exit = await Effect.runPromiseExit(readPluginsLock(path.join(context.root, LOCK_FILE)))
  if (Exit.isSuccess(exit)) return exit.value
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  throw failure === undefined
    ? new Error(String(exit.cause))
    : new UsageError(failure.error.message)
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** What a release names a binary: `runbooks-credential-aws_0.1.0_darwin_arm64`, `.exe` on Windows. */
function assetName(plugin: PluginEntry, platform: Platform): string {
  const [os, arch] = platform.split("-")
  return `runbooks-${plugin.kind}-${plugin.name}_${plugin.version}_${os}_${arch}${os === "windows" ? ".exe" : ""}`
}

const KINDS = PluginKind.literals.join("|")
/** A file name the transport owner could start: `runbooks-<kind>-...`. */
const PLUGIN_BINARY = new RegExp(`^runbooks-(?:${KINDS})-`)
const ASSET = new RegExp(
  `^runbooks-(${KINDS})-([a-z0-9]+(?:-[a-z0-9]+)*)_([0-9A-Za-z.-]+)_([a-z0-9]+)_([a-z0-9]+)(\\.exe)?$`,
)

interface Asset {
  readonly kind: PluginKind
  readonly name: string
  readonly version: string
  readonly os: string
  readonly arch: string
  readonly exe: boolean
}

function parseAsset(name: string): Asset | undefined {
  const [, kind, plugin, version, os, arch, exe] = ASSET.exec(name) ?? []
  const decoded = Schema.decodeUnknownOption(PluginKind)(kind)
  if (Option.isNone(decoded) || plugin === undefined || version === undefined) return undefined
  if (os === undefined || arch === undefined) return undefined
  return { kind: decoded.value, name: plugin, version, os, arch, exe: exe !== undefined }
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

interface Wanted {
  /** The installed name, in the bin folder. */
  readonly file: string
  readonly asset: string
  readonly version: string
  readonly sha256: string
}

/** What the lock pins for `platform`, or the plugins it pins no binary for there. */
function wantedFor(plugins: ReadonlyArray<PluginEntry>, platform: Platform) {
  const wanted: Array<Wanted> = []
  const unpinned: Array<string> = []
  for (const plugin of plugins) {
    const sha256 = plugin.sha256[platform]
    if (sha256 === undefined) unpinned.push(`${plugin.kind} ${plugin.name}`)
    else {
      wanted.push({
        file: binaryName(plugin.kind, plugin.name, platform),
        asset: assetName(plugin, platform),
        version: plugin.version,
        sha256,
      })
    }
  }
  return { wanted, unpinned }
}

const EXECUTABLE = 0o755

async function fetchPlugins(
  context: Context,
  plugins: ReadonlyArray<PluginEntry>,
  platform: Platform,
): Promise<number> {
  const { wanted, unpinned } = wantedFor(plugins, platform)
  if (unpinned.length > 0) {
    context.err(
      `${LOCK_FILE} has no ${platform} hash for ${unpinned.join(", ")}: its release builds no binary for ${platform}, so none is fetched.`,
    )
    return EXIT.mismatch
  }
  const binDir = path.join(context.root, BIN_DIR)
  const staging = await fs.mkdtemp(path.join(path.dirname(binDir), STAGING_PREFIX))
  try {
    const problems: Array<string> = []
    const staged: Array<{ readonly from: string; readonly to: string }> = []
    const installed: Array<string> = []
    for (const binary of wanted) {
      const target = path.join(binDir, binary.file)
      const present = await inspect(target, context.limits.binaryBytes)
      if (present.kind === "file" && present.sha256 === binary.sha256) {
        installed.push(target)
        continue
      }
      const from = path.join(staging, binary.file)
      const url = `${context.releases.download}/${REPO}/releases/download/v${binary.version}/${binary.asset}`
      const download = await downloadTo(url, from, context.limits)
      if (download.kind === "failed") problems.push(`${binary.asset}: ${download.reason}`)
      else if (download.sha256 !== binary.sha256) {
        problems.push(mismatch(binary.asset, binary.sha256, download.sha256))
      } else staged.push({ from, to: target })
    }
    if (problems.length > 0) {
      for (const problem of problems) context.err(problem)
      context.err(`fetch failed for ${platform}: nothing was moved into ${BIN_DIR}.`)
      return EXIT.mismatch
    }
    await fs.mkdir(binDir, { recursive: true })
    for (const { from, to } of staged) {
      await fs.chmod(from, EXECUTABLE)
      await fs.rename(from, to)
    }
    for (const target of installed) await fs.chmod(target, EXECUTABLE)
    const keep = new Set(wanted.map((binary) => binary.file))
    for (const file of await pluginBinariesIn(binDir)) {
      if (keep.has(file)) continue
      await fs.rm(path.join(binDir, file), { force: true })
      context.err(`removed ${BIN_DIR}/${file}: ${LOCK_FILE} pins no such ${platform} binary`)
    }
    for (const binary of wanted) context.out(`${binary.sha256}  ${binary.file}`)
    return EXIT.ok
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

const mismatch = (subject: string, expected: string, actual: string) =>
  `${subject}: SHA-256 mismatch\n  expected ${expected}\n  actual   ${actual}`

type Download =
  | { readonly kind: "done"; readonly sha256: string }
  | { readonly kind: "failed"; readonly reason: string }

/** Downloads `url` to a new file, owner-only, hashing it as it comes. */
async function downloadTo(url: string, file: string, limits: Limits): Promise<Download> {
  const hash = createHash("sha256")
  const handle = await fs.open(file, "wx", 0o600)
  try {
    const failed = await get(url, limits.binaryBytes, limits.requestMillis, async (chunk) => {
      hash.update(chunk)
      await handle.write(chunk)
    })
    if (failed !== undefined) return { kind: "failed", reason: failed }
  } finally {
    await handle.close()
  }
  return { kind: "done", sha256: hash.digest("hex") }
}

/** GETs `url`, giving each chunk of the answer to `take`. Why it failed, or undefined. */
async function get(
  url: string,
  limit: number,
  timeoutMillis: number,
  take: (chunk: Uint8Array) => void | Promise<void>,
  headers: Record<string, string> = {},
): Promise<string | undefined> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMillis), headers })
  } catch (error) {
    return `request to ${url} failed: ${messageOf(error)}`
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    return `HTTP ${response.status} from ${url}`
  }
  let received = 0
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength
      if (received > limit) return `larger than ${limit} bytes, the limit for it`
      await take(chunk)
    }
  } catch (error) {
    return `download from ${url} failed: ${messageOf(error)}`
  }
  return undefined
}

async function getText(
  url: string,
  limit: number,
  limits: Limits,
  headers: Record<string, string> = {},
) {
  const chunks: Array<Uint8Array> = []
  const failed = await get(
    url,
    limit,
    limits.requestMillis,
    (chunk) => {
      chunks.push(chunk)
    },
    headers,
  )
  return failed === undefined
    ? ({ kind: "done", text: Buffer.concat(chunks).toString("utf8") } as const)
    : ({ kind: "failed", reason: failed } as const)
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

type Present =
  | { readonly kind: "missing" }
  | { readonly kind: "notAFile" }
  | { readonly kind: "tooLarge" }
  | { readonly kind: "file"; readonly sha256: string; readonly executable: boolean }

/** What is at `file`: a symlink is not a file, and one past `limit` bytes is not hashed. */
async function inspect(file: string, limit: number): Promise<Present> {
  let info
  try {
    info = await fs.lstat(file)
  } catch (error) {
    if (Predicate.hasProperty(error, "code") && error.code === "ENOENT") return { kind: "missing" }
    throw error
  }
  if (!info.isFile()) return { kind: "notAFile" }
  if (info.size > limit) return { kind: "tooLarge" }
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return { kind: "file", sha256: hash.digest("hex"), executable: (info.mode & 0o111) !== 0 }
}

/** The files in `dir` named like a plugin binary. A missing folder holds none. */
async function pluginBinariesIn(dir: string): Promise<ReadonlyArray<string>> {
  try {
    return (await fs.readdir(dir)).filter((file) => PLUGIN_BINARY.test(file)).sort()
  } catch (error) {
    if (Predicate.hasProperty(error, "code") && error.code === "ENOENT") return []
    throw error
  }
}

async function checkPlugins(
  context: Context,
  plugins: ReadonlyArray<PluginEntry>,
  platform: Platform,
  binDir: string,
): Promise<number> {
  const { wanted } = wantedFor(plugins, platform)
  const shown = path.relative(context.root, binDir) || "."
  const problems: Array<string> = []
  const mustExecute = !platform.startsWith("windows-") && context.host.platform !== "win32"
  for (const binary of wanted) {
    const at = `${shown}/${binary.file}`
    const present = await inspect(path.join(binDir, binary.file), context.limits.binaryBytes)
    switch (present.kind) {
      case "missing":
        problems.push(`${at}: missing; ${LOCK_FILE} pins it for ${platform}`)
        break
      case "notAFile":
        problems.push(`${at}: not a regular file`)
        break
      case "tooLarge":
        problems.push(
          `${at}: larger than ${context.limits.binaryBytes} bytes, so not the pinned binary`,
        )
        break
      case "file":
        if (present.sha256 !== binary.sha256)
          problems.push(mismatch(at, binary.sha256, present.sha256))
        else if (mustExecute && !present.executable) problems.push(`${at}: not executable`)
        break
      default: {
        const unhandled: never = present
        throw new Error(`unhandled ${JSON.stringify(unhandled)}`)
      }
    }
  }
  const pinned = new Set(wanted.map((binary) => binary.file))
  for (const file of await pluginBinariesIn(binDir)) {
    if (!pinned.has(file))
      problems.push(`${shown}/${file}: ${LOCK_FILE} pins no such ${platform} binary`)
  }
  if (problems.length > 0) {
    for (const problem of problems) context.err(problem)
    context.err(`${shown} does not hold what ${LOCK_FILE} pins for ${platform}.`)
    return EXIT.mismatch
  }
  for (const binary of wanted) context.out(`${binary.sha256}  ${binary.file}`)
  return EXIT.ok
}

// ---------------------------------------------------------------------------
// bump
// ---------------------------------------------------------------------------

/** The fields of GitHub's release object this reads. `digest` is `sha256:<hex>`. */
const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(
    Schema.Struct({ name: Schema.String, digest: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
})

const SUMS_LINE = /^([0-9a-f]{64}) [ *]([0-9A-Za-z._-]+)$/

/** `SHA256SUMS` in `shasum -a 256` format: file name to hash, and each line that is not one. */
function parseSums(text: string) {
  const sums = new Map<string, string>()
  const problems: Array<string> = []
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  lines.forEach((line, at) => {
    const [, sha256, file] = SUMS_LINE.exec(line) ?? []
    if (sha256 === undefined || file === undefined) {
      problems.push(
        `SHA256SUMS line ${at + 1}: expected "<sha256>  <file>", got ${JSON.stringify(line.slice(0, 100))}`,
      )
    } else if (sums.has(file)) problems.push(`SHA256SUMS line ${at + 1}: ${file} is listed twice`)
    else sums.set(file, sha256)
  })
  return { sums, problems }
}

async function bump(context: Context, version: string): Promise<number> {
  const tag = `v${version}`
  const release = `${REPO} ${tag}`
  const fail = (problems: ReadonlyArray<string>) => {
    for (const problem of problems) context.err(problem)
    context.err(`${LOCK_FILE} is unchanged.`)
    return EXIT.mismatch
  }
  const described = await getText(
    `${context.releases.api}/repos/${REPO}/releases/tags/${tag}`,
    context.limits.releaseBytes,
    context.limits,
    { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  )
  if (described.kind === "failed") return fail([`${release}: ${described.reason}`])
  const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(GitHubRelease))(described.text)
  if (Exit.isFailure(decoded)) return fail([`${release}: the API's answer is not a release`])
  if (decoded.value.tag_name !== tag) {
    return fail([`${release}: the API answered with ${JSON.stringify(decoded.value.tag_name)}`])
  }
  const listed = await getText(
    `${context.releases.download}/${REPO}/releases/download/${tag}/SHA256SUMS`,
    context.limits.sumsBytes,
    context.limits,
  )
  if (listed.kind === "failed") return fail([`${release} SHA256SUMS: ${listed.reason}`])

  const { sums, problems } = parseSums(listed.text)
  const digests = new Map(decoded.value.assets.map((asset) => [asset.name, asset.digest]))
  for (const asset of decoded.value.assets) {
    if (parseAsset(asset.name) !== undefined && !sums.has(asset.name)) {
      problems.push(`${asset.name}: in ${release} but not in its SHA256SUMS`)
    }
  }
  const plugins = new Map<
    string,
    { kind: PluginKind; name: string; sha256: Map<Platform, string> }
  >()
  for (const [file, sha256] of sums) {
    const asset = parseAsset(file)
    if (asset === undefined) continue
    if (!digests.has(file)) {
      problems.push(`${file}: in SHA256SUMS but not in ${release}`)
      continue
    }
    const digest = digests.get(file)
    if (digest === undefined || digest === null) {
      problems.push(`${file}: the API gives no digest for it`)
      continue
    }
    if (digest !== `sha256:${sha256}`) {
      problems.push(
        `${file}: SHA256SUMS and the API disagree\n  SHA256SUMS ${sha256}\n  API        ${digest}`,
      )
      continue
    }
    if (asset.version !== version) {
      problems.push(`${file}: version ${asset.version}, in ${release}`)
      continue
    }
    const platform = Schema.decodeUnknownOption(Platform)(`${asset.os}-${asset.arch}`)
    if (Option.isNone(platform)) {
      context.err(`skipped ${file}: the app knows no platform ${asset.os}-${asset.arch}`)
      continue
    }
    if (asset.exe !== (asset.os === "windows")) {
      problems.push(`${file}: a ${asset.os} binary ${asset.exe ? "with" : "without"} .exe`)
      continue
    }
    const key = `${asset.kind} ${asset.name}`
    const plugin = plugins.get(key) ?? { kind: asset.kind, name: asset.name, sha256: new Map() }
    plugin.sha256.set(platform.value, sha256)
    plugins.set(key, plugin)
  }
  if (problems.length === 0 && plugins.size === 0)
    problems.push(`${release}: its SHA256SUMS lists no plugin binary`)
  if (problems.length > 0) return fail(problems)

  const lock = Schema.decodeUnknownSync(PluginsLock)({
    plugins: [...plugins.values()]
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
      .map((plugin) => ({
        name: plugin.name,
        kind: plugin.kind,
        version,
        sha256: Object.fromEntries(
          Platform.literals.flatMap((platform) => {
            const sha256 = plugin.sha256.get(platform)
            return sha256 === undefined ? [] : [[platform, sha256]]
          }),
        ),
      })),
  })
  const file = path.join(context.root, LOCK_FILE)
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(lock, null, 2)}\n`)
  await fs.rename(`${file}.tmp`, file)
  context.err(`wrote ${LOCK_FILE}: ${lock.plugins.length} plugins at ${version}`)
  return EXIT.ok
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    root: path.resolve(import.meta.dirname, "../.."),
    releases: { download: "https://github.com", api: "https://api.github.com" },
    limits: LIMITS,
    host: { platform: process.platform, arch: process.arch },
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  })
}
