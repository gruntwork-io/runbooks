/**
 * Live implementation of the VcsCredentials service (vcs-auth-v2-design.md §6).
 *
 * Owns: the per-(binary,host) 5-minute CLI read cache + its invalidation
 * rules (§2.3), the CLI version-probe cache, the §2.4 validation probe (both
 * token shapes), and the transport-degraded host set. Per-host glab spawn
 * serialization and child-env hygiene live in the domain modules this layer
 * composes.
 */
import { Context, Effect, Layer, Stream } from "effect"
import { VcsCredentials } from "../services/VcsCredentials.ts"
import type {
  CliValidation,
  DetectionResult,
  MergedGitLabHosts,
  VcsCredentialsShape,
  VcsCliStatusInfo,
  VcsCredentialSource,
  VcsProvider,
  VcsUserInfo,
} from "../services/VcsCredentials.ts"
import { Environment } from "../services/Environment.ts"
import { FileSystem } from "../services/FileSystem.ts"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import { GitHubClient } from "../services/GitHubClient.ts"
import { GitLabClient } from "../services/GitLabClient.ts"
import { GitHubApiError, GitLabApiError, VcsCliError } from "../errors/index.ts"
import {
  detectEnvCredentials as detectGitHubEnvCredentials,
  detectCliCredentials as detectGitHubCliToken,
  detectHostsYmlCredentials,
  cliScopes as detectGhCliScopes,
  GH_ENV_OVERRIDES,
} from "../domain/github/auth.ts"
import {
  detectEnvCredentials as detectGitLabEnvCredentials,
  detectConfigCredentials,
  detectConfigHosts,
  detectHostMeta,
  isSpawnEnoent,
  readGlabTokenForHost,
  runGlabForHost,
  glabAuthStatusForHost,
  mayAutoSendEnvToken,
  envTokenHost,
  DEFAULT_GITLAB_HOST,
} from "../domain/gitlab/auth.ts"
import type { GlabCliRead } from "../domain/gitlab/auth.ts"
import { probeGhStatus, probeGlabStatus, probeGitSslBackend } from "../domain/vcs/cli-status.ts"
import { redactSecrets } from "../domain/vcs/redact.ts"
import { buildCliEnv } from "../domain/git/cli-token.ts"
import {
  isGitLabHost,
  normalizeGitLabBaseUrl,
  normalizeGitLabHost,
} from "../domain/git/gitlab-host.ts"

// §2.2/§7 exact copies — contracts.
const GH_KEYRING_HINT = "gh stores this token in the OS keyring; install gh or paste a token."
const GLAB_KEYRING_BLOCKED_HINT =
  "glab stores this token in the OS keyring but could not read it — unlock your keyring or paste a token."
const GLAB_KEYRING_ABSENT_HINT =
  "glab is configured to store tokens in the keyring; install glab or paste a token"
const ENV_DIVERGENCE_HINT =
  "GH_TOKEN is also set and differs; Runbooks used GITHUB_TOKEN — gh would use GH_TOKEN."
const glabOAuthStaleWarning = (host: string) =>
  `GitLab CLI token for ${host} has expired. Run 'glab auth login --hostname ${host}' to refresh.`
const glabInvalidWarning = (host: string) => `glab token for ${host} is invalid or expired`

/** §2.3: shortened from golang's process-lifetime cache — glab OAuth tokens rot in 2h. */
const CLI_READ_TTL_MS = 5 * 60_000
const PROBE_TIMEOUT_MS = 10_000

interface CacheEntry<T> {
  readonly value: T
  readonly expiresAt: number
}

const absent = (extra: Partial<DetectionResult> = {}): DetectionResult => ({
  outcome: "absent",
  warnings: [],
  ...extra,
})

interface DirectValidation {
  readonly ok: boolean
  readonly user?: VcsUserInfo
  readonly scopes?: string[]
  readonly status?: number
  readonly kind?: DetectionResult["errorKind"]
  readonly message?: string
}

/**
 * Map a direct validation onto the §2.0 tri-state result: ok → valid,
 * transport kind → unreachable, else invalid (never "expired" — a 401 cannot
 * distinguish expired from wrong-host).
 */
const toDetection = (
  validation: DirectValidation,
  base: Partial<DetectionResult>,
  invalidWarnings: string[],
): DetectionResult => {
  if (validation.ok) {
    return {
      outcome: "valid",
      ...base,
      user: validation.user,
      scopes: validation.scopes,
      warnings: [],
      validatedVia: "direct",
    }
  }
  if (validation.kind) {
    return {
      outcome: "unreachable",
      ...base,
      errorKind: validation.kind,
      status: validation.status,
      error: validation.message,
      warnings: [],
    }
  }
  return {
    outcome: "invalid",
    ...base,
    status: validation.status,
    error: validation.message,
    warnings: invalidWarnings,
  }
}

/** Unprefixed 64-hex = glab OAuth-shaped (§2.4). */
const isGitLabOAuthShaped = (token: string): boolean => /^[0-9a-f]{64}$/i.test(token)

export const VcsCredentialsLive = Layer.effect(
  VcsCredentials,
  Effect.gen(function* () {
    const environment = yield* Environment
    const spawner = yield* ProcessSpawner
    const fs = yield* FileSystem
    const githubClient = yield* GitHubClient
    const gitlabClient = yield* GitLabClient

    const domainContext = Context.empty().pipe(
      Context.add(Environment, environment),
      Context.add(ProcessSpawner, spawner),
      Context.add(FileSystem, fs),
    )
    const run = <A, E>(
      effect: Effect.Effect<A, E, Environment | ProcessSpawner | FileSystem>,
    ): Effect.Effect<A, E> => Effect.provide(effect, domainContext)

    // --- Caches + degraded-host set (closure state) ------------------------

    const cliReadCache = new Map<string, CacheEntry<unknown>>()
    let cliStatusCache: CacheEntry<VcsCliStatusInfo> | undefined
    const degradedHosts = new Map<string, string>()

    const cachedRead = <T>(key: string, compute: Effect.Effect<T>, cacheable: (value: T) => boolean) =>
      Effect.gen(function* () {
        const hit = cliReadCache.get(key)
        if (hit && hit.expiresAt > Date.now()) return hit.value as T
        const value = yield* compute
        // Only SUCCESSFUL reads are cached (§2.3); failures must stay fresh.
        if (cacheable(value)) {
          cliReadCache.set(key, { value, expiresAt: Date.now() + CLI_READ_TTL_MS })
        }
        return value
      })

    /** §2.3 invalidation: any auth failure flushes the relevant entry. */
    const flushOnAuthFailure = (key: string) => Effect.sync(() => cliReadCache.delete(key))

    const ghReadCached = cachedRead(
      "gh:github.com",
      run(detectGitHubCliToken()),
      (token) => token !== undefined,
    )
    const glabReadCached = (host: string) =>
      cachedRead(
        `glab:${host}`,
        run(readGlabTokenForHost(host)),
        (read: GlabCliRead) => read.kind === "token",
      )

    const cliStatus = (): Effect.Effect<VcsCliStatusInfo> =>
      Effect.gen(function* () {
        if (cliStatusCache && cliStatusCache.expiresAt > Date.now()) return cliStatusCache.value
        const probes = { gh: run(probeGhStatus()), glab: run(probeGlabStatus()) }
        const status: VcsCliStatusInfo =
          process.platform === "win32"
            ? yield* Effect.all(
                {
                  ...probes,
                  git: run(probeGitSslBackend()).pipe(Effect.map((sslBackend) => ({ sslBackend }))),
                },
                { concurrency: "unbounded" },
              )
            : yield* Effect.all(probes, { concurrency: "unbounded" })
        cliStatusCache = { value: status, expiresAt: Date.now() + CLI_READ_TTL_MS }
        return status
      })

    // --- Direct validation (one transport: global fetch via the clients) ---

    const validateGitHubDirect = (token: string): Effect.Effect<DirectValidation> =>
      githubClient.validateToken(token).pipe(
        Effect.map((v): DirectValidation => ({ ok: true, user: v.user, scopes: v.scopes })),
        Effect.catchAll((err: GitHubApiError) =>
          Effect.succeed<DirectValidation>({ ok: false, status: err.status, kind: err.kind, message: err.message }),
        ),
      )

    const validateGitLabDirect = (token: string, host: string): Effect.Effect<DirectValidation> =>
      gitlabClient.validateToken(token, normalizeGitLabBaseUrl(host)).pipe(
        Effect.map((v): DirectValidation => ({ ok: true, user: v.user, scopes: v.scopes })),
        Effect.catchAll((err: GitLabApiError) =>
          Effect.succeed<DirectValidation>({ ok: false, status: err.status, kind: err.kind, message: err.message }),
        ),
      )

    // --- Detection legs (§2.1/§2.2) -----------------------------------------

    const detectGitHubEnv = (prefix?: string): Effect.Effect<DetectionResult> =>
      Effect.gen(function* () {
        const cred = yield* run(detectGitHubEnvCredentials(prefix))
        if (!cred) return absent()
        const validation = yield* validateGitHubDirect(cred.token)
        const base = {
          token: cred.token,
          source: "env" as const,
          envVar: cred.envVar,
          divergenceHint: cred.shadowedVar ? ENV_DIVERGENCE_HINT : undefined,
        }
        return toDetection(validation, base, [`${cred.envVar} is not valid for github.com`])
      })

    const detectGitHubCli = (): Effect.Effect<DetectionResult> =>
      Effect.gen(function* () {
        let token = yield* ghReadCached
        let source: "cli" | "config" = "cli"
        if (!token) {
          // §2.1 #3b: hosts.yml is the gh-BINARY-ABSENT-ONLY fallback.
          const status = yield* cliStatus()
          if (!status.gh.installed) {
            const fallback = yield* run(detectHostsYmlCredentials())
            if (fallback.token) {
              token = fallback.token
              source = "config"
            } else if (fallback.entryExists) {
              return absent({ hint: GH_KEYRING_HINT })
            }
          }
          if (!token) return absent()
        }
        const validation = yield* validateGitHubDirect(token)
        if (!validation.ok) yield* flushOnAuthFailure("gh:github.com")
        // Supplement scopes via `gh auth status` for cli-sourced tokens
        // (§2.1) — advisory; skipped for the binary-absent fallback.
        let scopes = validation.scopes
        if (validation.ok && (!scopes || scopes.length === 0) && source === "cli") {
          scopes = (yield* run(detectGhCliScopes())) ?? scopes
        }
        return toDetection({ ...validation, scopes }, { token, source }, [
          "GitHub CLI token is invalid or expired",
        ])
      })

    const detectGitLabEnv = (instance: string): Effect.Effect<DetectionResult> =>
      Effect.gen(function* () {
        const host = normalizeGitLabHost(instance)
        const cred = yield* run(detectGitLabEnvCredentials())
        if (!cred) return absent()
        // §2.2/§8 binding rule: the env token is bound to exactly ONE host and
        // is never transmitted to any other.
        const allEnv = yield* environment.getAll()
        if (!mayAutoSendEnvToken(host, allEnv)) return absent()
        const validation = yield* validateGitLabDirect(cred.token, instance)
        const base = { token: cred.token, source: "env" as const, envVar: cred.envVar }
        return toDetection(validation, base, [`${cred.envVar} is not valid for ${host}`])
      })

    const detectGitLabCli = (instance: string): Effect.Effect<DetectionResult> =>
      Effect.gen(function* () {
        const host = normalizeGitLabHost(instance)
        const read = yield* glabReadCached(host)
        let token: string | undefined
        let source: "cli" | "config" = "cli"
        switch (read.kind) {
          case "token":
            token = read.token
            break
          case "keyring-blocked":
            // Contract (c): distinct copy, never "install glab" (§7).
            return absent({ hint: GLAB_KEYRING_BLOCKED_HINT })
          case "oauth-stale":
            return {
              outcome: "invalid",
              source: "cli",
              warnings: [glabOAuthStaleWarning(host)],
              error: glabOAuthStaleWarning(host),
            }
          case "not-installed": {
            // §2.2 source #3: config.yml is the glab-BINARY-ABSENT-ONLY fallback.
            token = yield* run(detectConfigCredentials(host))
            source = "config"
            if (!token) {
              const meta = yield* run(detectHostMeta(host))
              if (meta?.useKeyring) return absent({ hint: GLAB_KEYRING_ABSENT_HINT })
              return absent()
            }
            break
          }
          case "absent":
            return absent()
        }
        const validation = yield* validateGitLabDirect(token, instance)
        if (!validation.ok) yield* flushOnAuthFailure(`glab:${host}`)
        if (validation.ok || validation.kind) {
          return toDetection(validation, { token, source }, [])
        }
        // §2.2 #3: an OAuth credential that still validates invalid after the
        // staleness path gets the expired-token remediation.
        const meta = yield* run(detectHostMeta(host))
        const warning = meta?.isOAuth2 ? glabOAuthStaleWarning(host) : glabInvalidWarning(host)
        return toDetection(validation, { token, source }, [warning])
      })

    // --- Full chains (§2): invalid continues, unreachable stops -------------

    const chain = (
      legs: Array<Effect.Effect<DetectionResult>>,
    ): Effect.Effect<DetectionResult> =>
      Effect.gen(function* () {
        const warnings: string[] = []
        let hint: string | undefined
        for (const leg of legs) {
          const result = yield* leg
          if (result.outcome === "valid" || result.outcome === "unreachable") {
            return { ...result, warnings: [...warnings, ...result.warnings] }
          }
          warnings.push(...result.warnings)
          hint = result.hint ?? hint
        }
        // An empty final result is NOT an error — the repo may be public.
        return absent({ warnings, hint })
      })

    const resolveGitHub = (prefix?: string) => chain([detectGitHubEnv(prefix), detectGitHubCli()])
    const resolveGitLab = (instance: string) =>
      chain([detectGitLabEnv(instance), detectGitLabCli(instance)])

    const validateDirect = (
      provider: VcsProvider,
      host: string,
      token: string,
    ): Effect.Effect<DetectionResult> =>
      Effect.gen(function* () {
        const validation =
          provider === "github"
            ? yield* validateGitHubDirect(token)
            : yield* validateGitLabDirect(token, host)
        return toDetection(validation, { token }, [])
      })

    // --- §2.3 read-only host→token (golang semantics, no network) ----------

    const tokenForHost = (rawHost: string): Effect.Effect<string | undefined> =>
      Effect.gen(function* () {
        const host = rawHost.trim().toLowerCase()
        if (host === "github.com") {
          const cred = yield* run(detectGitHubEnvCredentials())
          if (cred) return cred.token
          const cli = yield* ghReadCached
          if (cli) return cli
          const status = yield* cliStatus()
          if (!status.gh.installed) {
            const fallback = yield* run(detectHostsYmlCredentials())
            if (fallback.token) return fallback.token
          }
          return undefined
        }

        // GitLab branch: union membership — glab config hosts + the env-bound
        // host — not the name heuristic alone (the `git.corp.net` blind spot).
        // The heuristic stays as the final fallback for
        // never-configured-but-obvious hosts.
        const allEnv = yield* environment.getAll()
        const { hosts } = yield* run(detectConfigHosts())
        const isKnownGitLab =
          host === DEFAULT_GITLAB_HOST ||
          hosts.some((h) => h.toLowerCase() === host) ||
          envTokenHost(allEnv) === host ||
          isGitLabHost(host)
        if (!isKnownGitLab) return undefined // not an error; public repos must work

        if (mayAutoSendEnvToken(host, allEnv)) {
          const cred = yield* run(detectGitLabEnvCredentials())
          if (cred) return cred.token
        }
        const read = yield* glabReadCached(host)
        if (read.kind === "token") return read.token
        if (read.kind === "not-installed") {
          return yield* run(detectConfigCredentials(host))
        }
        return undefined
      })

    // --- §2.4 validation-only CLI probe -------------------------------------

    const runCli = (
      command: string,
      args: string[],
      childEnv: Record<string, string | undefined>,
    ): Effect.Effect<{ exitCode: number; stdout: string[]; stderr: string[] }, VcsCliError> =>
      Effect.gen(function* () {
        const proc = yield* spawner.spawn(command, args, { env: childEnv }).pipe(
          Effect.mapError(
            (err) =>
              new VcsCliError({
                kind: isSpawnEnoent(err) ? "not-installed" : "spawn",
                stderr: "",
              }),
          ),
        )
        const stdout: string[] = []
        const stderr: string[] = []
        const exitCode = yield* Effect.ensuring(
          Effect.gen(function* () {
            yield* proc.output.pipe(
              Stream.runForEach((line) =>
                Effect.sync(() => {
                  ;(line.source === "stdout" ? stdout : stderr).push(line.line)
                }),
              ),
              Effect.timeout(PROBE_TIMEOUT_MS),
            )
            return yield* proc.exitCode.pipe(Effect.timeout(PROBE_TIMEOUT_MS))
          }),
          proc.kill.pipe(Effect.ignore),
        ).pipe(Effect.mapError(() => new VcsCliError({ kind: "timeout", stderr: "" })))
        return { exitCode, stdout, stderr }
      })

    /** Parse `gh api user -i` output: status line + headers + JSON body. */
    const parseGhApiUser = (output: string): CliValidation | undefined => {
      const scopesMatch = /^x-oauth-scopes:\s*(.+)$/im.exec(output)
      const scopes = scopesMatch
        ? scopesMatch[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0)
        : undefined
      const jsonStart = output.indexOf("{")
      if (jsonStart === -1) return undefined
      try {
        const data = JSON.parse(output.slice(jsonStart)) as {
          login?: string
          name?: string
          avatar_url?: string
          email?: string
        }
        if (!data.login) return undefined
        return {
          user: { login: data.login, name: data.name ?? undefined, avatarUrl: data.avatar_url, email: data.email ?? undefined },
          scopes: scopes && scopes.length > 0 ? scopes : undefined,
        }
      } catch {
        return undefined
      }
    }

    const probeGitHub = (token: string): Effect.Effect<CliValidation, VcsCliError> =>
      Effect.gen(function* () {
        const status = yield* cliStatus()
        if (!status.gh.installed) {
          return yield* Effect.fail(new VcsCliError({ kind: "not-installed", stderr: "" }))
        }
        if (!status.gh.meetsFloor) {
          return yield* Effect.fail(
            new VcsCliError({ kind: "api", stderr: `gh ${status.gh.version ?? "?"} is below the supported floor` }),
          )
        }
        // Pin gh to validate exactly the candidate (env-over-stored-creds is
        // documented gh behavior); token via CHILD ENV only, never argv.
        const childEnv = {
          ...buildCliEnv(yield* environment.getAll(), GH_ENV_OVERRIDES),
          GH_TOKEN: token,
        }
        // -i exposes headers, so X-OAuth-Scopes still yields scopes. The
        // --hostname pin mirrors the detection path: without it, GH_HOST
        // (which the hygiene overrides also strip) would aim the probe — and
        // the candidate token — at a GHES origin instead of github.com (§8).
        const result = yield* runCli("gh", ["api", "user", "-i", "--hostname", "github.com"], childEnv)
        if (result.exitCode !== 0) {
          return yield* Effect.fail(new VcsCliError({ kind: "api", stderr: redactSecrets(result.stderr.join("\n")) }))
        }
        const parsed = parseGhApiUser(result.stdout.join("\n"))
        if (!parsed) {
          return yield* Effect.fail(new VcsCliError({ kind: "api", stderr: "unparseable gh api output" }))
        }
        return parsed
      })

    const probeGitLab = (
      host: string,
      token: string,
      source: VcsCredentialSource,
    ): Effect.Effect<CliValidation, VcsCliError> =>
      Effect.gen(function* () {
        const status = yield* cliStatus()
        if (!status.glab.installed) {
          return yield* Effect.fail(new VcsCliError({ kind: "not-installed", stderr: "" }))
        }
        if (!status.glab.meetsFloor) {
          return yield* Effect.fail(
            new VcsCliError({ kind: "api", stderr: `glab ${status.glab.version ?? "?"} is below the supported floor` }),
          )
        }

        if (isGitLabOAuthShaped(token)) {
          // OAuth-shaped tokens are NEVER probed via token env injection —
          // glab may send an env-injected GITLAB_TOKEN as PRIVATE-TOKEN, which
          // OAuth tokens reject; a spurious 401 would corrupt the tri-state.
          // When glab's stored credential IS the candidate, `glab auth status`
          // (exit code + stderr, no token env) is the probe.
          if (source !== "cli" && source !== "config") {
            return yield* Effect.fail(
              new VcsCliError({ kind: "api", stderr: "env-sourced OAuth-shaped tokens are direct-fetch-only" }),
            )
          }
          const authStatus = yield* run(glabAuthStatusForHost(host))
          if (authStatus === "ok") {
            // Identity is best-effort from glab's own status line.
            return { user: { login: "glab" } }
          }
          if (authStatus === "not-logged-in") {
            return yield* Effect.fail(new VcsCliError({ kind: "not-authenticated", stderr: "No token found" }))
          }
          return yield* Effect.fail(new VcsCliError({ kind: "api", stderr: "API call failed" }))
        }

        // glpat--shaped: candidate via child env (GITLAB_TOKEN — others are
        // stripped by the hygiene overrides), per-host semaphore inside.
        const result = yield* run(
          runGlabForHost(host, ["api", "user", "--hostname", host], PROBE_TIMEOUT_MS, {
            GITLAB_TOKEN: token,
          }),
        ).pipe(
          Effect.mapError(
            (err) =>
              new VcsCliError({
                kind: isSpawnEnoent(err) ? "not-installed" : "spawn",
                stderr: "",
              }),
          ),
        )
        if (result.exitCode !== 0) {
          return yield* Effect.fail(new VcsCliError({ kind: "api", stderr: redactSecrets(result.stderr.join("\n")) }))
        }
        try {
          const data = JSON.parse(result.stdout.join("\n")) as {
            username?: string
            name?: string
            avatar_url?: string
            email?: string
          }
          if (!data.username) throw new Error("no username")
          return {
            user: {
              login: data.username,
              name: data.name ?? undefined,
              avatarUrl: data.avatar_url,
              email: data.email ?? undefined,
            },
          }
        } catch {
          return yield* Effect.fail(new VcsCliError({ kind: "api", stderr: "unparseable glab api output" }))
        }
      })

    const validateViaCli = (
      provider: VcsProvider,
      host: string,
      token: string,
      source: VcsCredentialSource,
    ): Effect.Effect<CliValidation, VcsCliError> =>
      provider === "github" ? probeGitHub(token) : probeGitLab(host, token, source)

    const shape: VcsCredentialsShape = {
      detectGitHubEnv,
      detectGitHubCli,
      detectGitLabEnv,
      detectGitLabCli,
      resolveGitHub,
      resolveGitLab,
      validateDirect,
      tokenForHost,
      enumerateGitLabHosts: (): Effect.Effect<MergedGitLabHosts> => run(detectConfigHosts()),
      validateViaCli,
      cliStatus,
      invalidateCache: () =>
        Effect.sync(() => {
          cliReadCache.clear()
          cliStatusCache = undefined
        }),
      markTransportDegraded: (host, code) =>
        Effect.sync(() => {
          degradedHosts.set(host, code)
          // Structured support signal + field canary for Node system-store
          // reader regressions (§2.4).
          console.warn(`transport degraded for ${host}: ${code}`)
        }),
      isTransportDegraded: (host) => Effect.sync(() => degradedHosts.has(host)),
      clearTransportDegraded: () => Effect.sync(() => degradedHosts.clear()),
    }

    return shape
  }),
)
