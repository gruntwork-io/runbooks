/**
 * Remote runbook resolution for the Electron app.
 *
 * Clones a remote source (parsed by src/remote-source.ts, which also decides
 * whether an input is remote at all) to a temp directory and resolves the
 * local runbook path within the clone.
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Cause, Effect, Exit } from "effect"
import { runtime, getSessionTokenForHost } from "./ipc/runtime.ts"
import { parseRemoteSource, redactSourceCredentials, resolveRef } from "../../src/remote-source.ts"
import { resolveRunbookPath } from "../../src/domain/workspace/file.ts"
import { isContainedInReal } from "../../src/path-validation.ts"
import { GitClient } from "../../src/services/GitClient.ts"
import { VcsCredentials } from "../../src/services/VcsCredentials.ts"
import { RemoteSourceError } from "../../src/errors/index.ts"
import { gitCredentialUsername, withGitHttpAuth } from "../../src/domain/git/url.ts"
import { gitSpawnEnv } from "../../src/domain/git/env.ts"
import { isGitLabHost } from "../../src/domain/git/gitlab-host.ts"
import { githubHostKind, isGitHubHost } from "../../src/domain/git/github-host.ts"
import { redactSecrets } from "../../src/domain/vcs/redact.ts"
import { makeLogger } from "./logger.ts"

const log = makeLogger("remote")

// ---------------------------------------------------------------------------
// Error classification — give users actionable hints when a clone fails.
// ---------------------------------------------------------------------------

/**
 * Returns true if a git stderr string looks like an authentication failure.
 * Golang-parity semantics (beta-v0.9.0 cmd/remote_open.go isAuthError —
 * note that an HTTP 404 / "repository not found" IS an auth signal: private
 * repos present as 404 to unauthenticated clients), plus a few extra
 * patterns git emits on this side.
 */
export function isAuthError(stderr: string): boolean {
  if (!stderr) return false
  const lower = stderr.toLowerCase()
  return (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("could not read password") ||
    lower.includes("http 404") ||
    lower.includes("repository not found") ||
    lower.includes("fatal: could not read") ||
    lower.includes("403") ||
    lower.includes("401") ||
    lower.includes("invalid credentials") ||
    lower.includes("bad credentials") ||
    lower.includes("permission denied") ||
    lower.includes("terminal prompts disabled")
  )
}

/**
 * Host-specific auth hints — golang parity (beta-v0.9.0 api.AuthHintForHost):
 * the env-var remedy and the CLI login command for a host, or undefined for
 * hosts we don't special-case. Hostname matching is case-insensitive.
 *
 * For a self-hosted GitLab host the env remedy names BOTH halves: per the
 * binding, GITLAB_TOKEN alone is only ever released to GITLAB_HOST's
 * instance (default gitlab.com), so "set GITLAB_TOKEN" without the binding
 * would advise a no-op. The same holds for an enterprise GitHub host: its env
 * token is released only when GH_HOST names it (GH_ENTERPRISE_TOKEN for GHES,
 * GITHUB_TOKEN for a ghe.com tenant).
 *
 * `provider` is the caller's provider detection for the host (a GHES host
 * has an arbitrary name, so only detection can place it); without it, only
 * github.com, `*.ghe.com` and GitLab-named hosts get a hint.
 */
export function authHintForHost(
  host: string,
  provider?: "github" | "gitlab",
): { envRemedy: string; cliCmd: string } | undefined {
  const lower = host.toLowerCase()
  if (lower === "github.com") {
    return { envRemedy: "GITHUB_TOKEN", cliCmd: "gh auth login" }
  }
  if (provider === "github" || (provider === undefined && isGitHubHost(lower))) {
    return {
      envRemedy:
        githubHostKind(lower) === "ghes"
          ? `GH_ENTERPRISE_TOKEN and GH_HOST=${lower}`
          : `GITHUB_TOKEN and GH_HOST=${lower}`,
      cliCmd: `gh auth login --hostname ${lower}`,
    }
  }
  if (provider === "gitlab" || isGitLabHost(lower)) {
    return lower === "gitlab.com"
      ? { envRemedy: "GITLAB_TOKEN", cliCmd: "glab auth login" }
      : {
          envRemedy: `GITLAB_TOKEN and GITLAB_HOST=${lower}`,
          cliCmd: `glab auth login --hostname ${lower}`,
        }
  }
  return undefined
}

export type CloneErrorKind = "auth" | "network" | "unknown"

export interface ClassifiedCloneError {
  readonly kind: CloneErrorKind
  readonly hint: string
}

/**
 * Classify a git clone failure into a user-facing message. The auth-case
 * strings are golang contracts (beta-v0.9.0 cmd/remote_open.go
 * classifyCloneError, pinned by the ported tests):
 *   no token:   authentication required for <host>/<owner>/<repo>: set <VAR>, or run '<cmd>'
 *   with token: authentication failed for <repo> (token may be invalid or
 *               expired): verify <VAR>, or re-run '<cmd>'
 */
export function classifyCloneError(opts: {
  host: string
  owner: string
  repo: string
  stderr: string
  hadToken: boolean
  provider?: "github" | "gitlab"
  /**
   * How the clone reached the host (default https). Tokens go only over
   * https: ssh authenticates with the user's keys, and http gets no token.
   */
  transport?: "https" | "http" | "ssh"
}): ClassifiedCloneError {
  const { host, owner, repo, stderr, hadToken, provider, transport } = opts
  const ssh = transport === "ssh"
  // A plain git source can name a repo with no owner (`git.corp.net/infra.git`).
  const repoPath = [host, owner, repo].filter(Boolean).join("/")
  if (ssh && (stderr ?? "").toLowerCase().includes("host key verification failed")) {
    return {
      kind: "auth",
      hint: `the SSH host key for ${host} is not trusted yet: connect to it once from a terminal to verify and save its key, or use an https:// URL`,
    }
  }
  if (isAuthError(stderr)) {
    if (ssh) {
      return {
        kind: "auth",
        hint: `SSH authentication failed for ${repoPath}: check that your SSH key is loaded (ssh-add) and has access to the repository, or use an https:// URL`,
      }
    }
    if (transport === "http") {
      return {
        kind: "auth",
        hint: `authentication required for ${repoPath}: access tokens are sent only over https, so use an https:// URL`,
      }
    }
    const hints = authHintForHost(host, provider)
    if (!hadToken) {
      return {
        kind: "auth",
        hint: hints
          ? `authentication required for ${repoPath}: set ${hints.envRemedy}, or run '${hints.cliCmd}'`
          : `authentication required for ${repoPath}: provide an access token for ${host}`,
      }
    }
    return {
      kind: "auth",
      hint: hints
        ? `authentication failed for ${repoPath} (token may be invalid or expired): verify ${hints.envRemedy}, or re-run '${hints.cliCmd}'`
        : `authentication failed for ${repoPath} (token may be invalid or expired)`,
    }
  }
  const lower = (stderr ?? "").toLowerCase()
  if (
    lower.includes("could not resolve host") ||
    lower.includes("connection refused") ||
    lower.includes("connection timed out") ||
    lower.includes("connect to host") ||
    lower.includes("network is unreachable")
  ) {
    return {
      kind: "network",
      hint: `Could not reach ${host}. Check your internet connection.`,
    }
  }
  return {
    kind: "unknown",
    // Shown to the user: git's stderr can echo a URL, so scrub it like every
    // other error that crosses IPC.
    hint: `failed to download runbook: ${redactSecrets(stderr) || "unknown error"}`,
  }
}

// ---------------------------------------------------------------------------
// Temp directory tracking
// ---------------------------------------------------------------------------

const tempCloneDirs = new Set<string>()

/**
 * Register a temp clone directory for later cleanup. Exposed mainly so the
 * tests can exercise cleanupTempClones without triggering a real clone.
 */
export function registerTempCloneDir(dir: string): void {
  tempCloneDirs.add(dir)
}

/**
 * Remove all temp clone directories. Called on app quit. Tolerates
 * already-deleted directories without throwing.
 */
export function cleanupTempClones(): void {
  for (const dir of tempCloneDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  }
  tempCloneDirs.clear()
}

// ---------------------------------------------------------------------------
// Remote runbook resolution
// ---------------------------------------------------------------------------

export interface RemoteRunbookResult {
  localPath: string
  remoteSource: string
}

/**
 * Parse a remote source, clone the repo (sparse when the source names a
 * path), and resolve the runbook file within the clone. Typed failures carry
 * a message fit to show the user.
 */
export const openRemoteRunbook = (rawUrl: string) =>
  Effect.gen(function* () {
    // What leaves this Effect (logs, errors, the header's remoteSource)
    // carries the source without any credentials typed into it.
    const source = redactSourceCredentials(rawUrl)

    // Parse the URL. Enterprise GitHub hosts the user configured (gh's
    // hosts.yml, GH_HOST) let a plain GHES repo URL parse as GitHub.
    log.info("Parsing URL:", source)
    const vcs = yield* VcsCredentials
    const { configHosts, envHost } = yield* vcs.enumerateGitHubHosts()
    let parsed = yield* parseRemoteSource(rawUrl, {
      githubHosts: envHost ? [...configHosts, envHost] : configHosts,
    })
    log.info("Parsed:", { host: parsed.host, owner: parsed.owner, repo: parsed.repo, ref: parsed.ref, path: parsed.path, refAndPath: parsed.refAndPath })

    // Get auth token early — needed for both resolveRef (git ls-remote)
    // and the clone itself. Session env first (a token established by
    // a GitAuth block is reused), then the unified VcsCredentials resolver.
    // Tokens ride only over https: an ssh clone authenticates with the
    // user's keys, and an http:// one would send the token in the clear.
    const transport = parsed.cloneURL.startsWith("https://")
      ? "https"
      : parsed.cloneURL.startsWith("http://")
        ? "http"
        : "ssh"
    const overHttps = transport === "https"
    log.info("Getting auth token...")
    // Provider detection by name AND the user's own config (a GHES host has
    // an arbitrary name): an unknown host is neither provider — never
    // "GitLab by default".
    const provider = yield* vcs.detectProvider(parsed.host)
    // Host-bound: the session token is released only to the host the
    // auth block bound it to — `parsed.host` is attacker-controlled input,
    // and the provider detection alone must never gate a credential.
    const sessionToken =
      overHttps && provider
        ? yield* getSessionTokenForHost(provider, parsed.host, () => new Error("no session token")).pipe(
            Effect.orElseSucceed(() => undefined),
          )
        : undefined
    const token = overHttps ? (sessionToken ?? (yield* vcs.tokenForHost(parsed.host))) : undefined
    log.info("Token:", token ? "found" : "none")
    // A token exists only for a detected provider (both sources above are
    // keyed on it), and a GitHub one may belong to github.com, a GHES host
    // or a ghe.com tenant: send the provider's username, so GitHub gets
    // `x-access-token` and GitLab (including self-managed) `oauth2`.
    const username = gitCredentialUsername(provider)

    // Browser URLs spell ref and path as one string; split it against the
    // remote's branches and tags.
    if (parsed.refAndPath !== undefined) {
      log.info("Resolving ref from:", parsed.refAndPath)
      const resolved = yield* resolveRef(
        parsed.cloneURL,
        parsed.refAndPath,
        withGitHttpAuth(gitSpawnEnv(), parsed.cloneURL, token, username),
      )
      parsed = { ...parsed, ref: resolved.ref, path: resolved.path, refAndPath: undefined }
      log.info("Resolved ref:", resolved.ref, "path:", resolved.path)
    }

    // Create temp directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-remote-"))
    registerTempCloneDir(tempDir)

    const dest = path.join(tempDir, "repo")
    log.info("Cloning to:", dest, "ref:", parsed.ref, "sparse:", parsed.path)

    // Clone with sparse checkout if a subpath is specified. Failures get
    // the golang-parity classification (remote-open strings).
    const git = yield* GitClient
    const { host, owner, repo, ref } = parsed
    yield* git
      .cloneSimple(parsed.cloneURL, dest, {
        ref,
        token,
        username,
        sparse: parsed.path,
      })
      .pipe(
        Effect.catchAll((err) => {
          const stderr =
            typeof (err as { stderr?: unknown }).stderr === "string"
              ? (err as { stderr: string }).stderr
              : String(err)
          const classified = classifyCloneError({
            host,
            owner,
            repo,
            stderr,
            hadToken: token !== undefined,
            provider,
            transport,
          })
          return Effect.fail(new RemoteSourceError({ url: source, message: classified.hint }))
        }),
      )
    log.info("Clone complete")

    // Resolve the runbook within the clone: a directory opens its
    // runbook.mdx, a file opens as-is.
    const repoLabel = [host, owner, repo].filter(Boolean).join("/")
    const at = ref ? ` at ${ref}` : ""
    const target = parsed.path ? path.join(dest, parsed.path) : dest
    if (!fs.existsSync(target)) {
      return yield* Effect.fail(
        new RemoteSourceError({ url: source, message: `"${parsed.path}" was not found in ${repoLabel}${at}` }),
      )
    }
    log.info("Resolving runbook in:", target)
    const localPath = yield* resolveRunbookPath(target).pipe(
      Effect.mapError(
        () =>
          new RemoteSourceError({
            url: source,
            message: `no runbook.mdx in ${parsed.path ? `"${parsed.path}"` : "the root"} of ${repoLabel}${at}`,
          }),
      ),
    )
    // The repo is untrusted: a symlink in it must not open a file outside
    // the clone.
    if (!(yield* Effect.promise(() => isContainedInReal(localPath, dest)))) {
      return yield* Effect.fail(
        new RemoteSourceError({ url: source, message: `"${parsed.path}" in ${repoLabel} points outside the repository` }),
      )
    }
    log.info("Resolved runbook path:", localPath)

    return {
      localPath,
      remoteSource: source,
    } satisfies RemoteRunbookResult
  })

/**
 * The value of a finished run, or a plain Error whose message is fit to show
 * the user. Typed failures carry that message; across IPC a FiberFailure
 * would reach the renderer as "(FiberFailure) RemoteSourceError: …".
 */
export function valueOrUserError<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.failureOption(exit.cause)
  const message = failure._tag === "Some" ? (failure.value as { message?: string }).message : undefined
  throw new Error(message || Cause.pretty(exit.cause))
}

/**
 * openRemoteRunbook on the app runtime. Rejects with a plain Error whose
 * message is fit to show the user.
 */
export async function resolveRemoteRunbook(rawUrl: string): Promise<RemoteRunbookResult> {
  return valueOrUserError(await runtime.runPromiseExit(openRemoteRunbook(rawUrl)))
}
