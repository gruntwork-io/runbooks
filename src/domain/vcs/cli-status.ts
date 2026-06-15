/**
 * VCS CLI diagnostics (the `vcs:cli-status`
 * channel): which provider CLIs are installed, their versions, whether they
 * meet the version floors the validation probe requires, and — on
 * Windows — which TLS backend git is configured with.
 *
 * Pure probe helpers; result caching lives with the caller
 * (VcsCredentialsLive).
 */
import { Effect, Stream } from "effect"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"

export interface CliStatus {
  readonly installed: boolean
  readonly version?: string
  /** Whether the installed version meets the probe floor. */
  readonly meetsFloor: boolean
}

/** gh ≥ 2.26.0 — keyring token storage introduction. */
export const GH_VERSION_FLOOR = "2.26.0"
/** glab ≥ 1.75.0 — support-policy floor, not a verified behavior cliff. */
export const GLAB_VERSION_FLOOR = "1.75.0"

/** `gh version 2.40.1 (2023-12-13)` */
const GH_VERSION_PATTERN = /gh version (\d+\.\d+\.\d+)/
/** `glab 1.55.0` and older `glab version 1.22.0` — loose on purpose. */
const GLAB_VERSION_PATTERN = /glab (?:version )?(\d+\.\d+\.\d+)/

const PROBE_TIMEOUT_MS = 5_000

/** Numeric triple comparison: negative when a < b. */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Run a command and collect combined output; undefined on spawn failure/timeout. */
const runForOutput = (
  command: string,
  args: string[],
): Effect.Effect<{ exitCode: number; output: string } | undefined, never, ProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const result = yield* Effect.either(
      Effect.gen(function* () {
        const proc = yield* spawner.spawn(command, args)
        const lines: string[] = []
        const exitCode = yield* Effect.ensuring(
          Effect.gen(function* () {
            yield* proc.output.pipe(
              Stream.runForEach((line) => Effect.sync(() => lines.push(line.line))),
              Effect.timeout(PROBE_TIMEOUT_MS),
            )
            return yield* proc.exitCode.pipe(Effect.timeout(PROBE_TIMEOUT_MS))
          }),
          proc.kill.pipe(Effect.ignore),
        )
        return { exitCode, output: lines.join("\n") }
      }),
    )
    return result._tag === "Left" ? undefined : result.right
  })

const probeCliStatus = (
  command: string,
  pattern: RegExp,
  floor: string,
): Effect.Effect<CliStatus, never, ProcessSpawner> =>
  Effect.gen(function* () {
    const result = yield* runForOutput(command, ["version"])
    if (!result || result.exitCode !== 0) {
      return { installed: false, meetsFloor: false }
    }
    const version = pattern.exec(result.output)?.[1]
    return {
      installed: true,
      version,
      // An unparseable version is treated as below-floor: the probe then
      // simply degrades to the remediation card (never breakage).
      meetsFloor: version !== undefined && compareVersions(version, floor) >= 0,
    }
  })

export const probeGhStatus = () => probeCliStatus("gh", GH_VERSION_PATTERN, GH_VERSION_FLOOR)
export const probeGlabStatus = () => probeCliStatus("glab", GLAB_VERSION_PATTERN, GLAB_VERSION_FLOOR)

/**
 * Sentinel sslBackend value for "git is present but the key is unset": git is
 * running on its compiled-in default, which is NOT schannel, so the
 * suggestion still applies. The renderer only ever tests `!== "schannel"`, but
 * the value crosses the vcs:cli-status channel — this const is its one owner.
 */
export const GIT_SSL_BACKEND_DEFAULT = "default"

/**
 * Read git's configured HTTPS backend (Windows): the Git-for-Windows
 * default is OpenSSL with its own CA bundle, which ignores the Windows
 * certificate store; only the opt-in `schannel` backend consults it. Cheap
 * read-only subprocess — we NEVER write git config without explicit consent.
 *
 * An UNSET key (`git config --get` exit 1 — portable/MSYS2 gits with no
 * configured backend) returns GIT_SSL_BACKEND_DEFAULT. Undefined means no
 * signal at all (git absent or the read itself failed).
 */
export const probeGitSslBackend = (): Effect.Effect<string | undefined, never, ProcessSpawner> =>
  Effect.gen(function* () {
    const result = yield* runForOutput("git", ["config", "--get", "http.sslBackend"])
    if (!result) return undefined
    if (result.exitCode === 1) return GIT_SSL_BACKEND_DEFAULT
    if (result.exitCode !== 0) return undefined
    const value = result.output.trim()
    return value.length > 0 ? value : GIT_SSL_BACKEND_DEFAULT
  })
