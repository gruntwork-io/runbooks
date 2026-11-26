/**
 * The runbook a remote source names (`isRemoteSource` in the core): a GitHub
 * or GitLab browser URL, or a go-getter source. It is cloned, and opened from
 * the clone. The old app's `electron/main/remote.ts`, with the same steps,
 * hints and failures.
 *
 * - Each clone gets a folder of its own, readable by its owner only, in the
 *   clones folder under the app's user data folder (`clonesFolder`). A failed
 *   open removes its folder. Main removes the whole clones folder when the
 *   app starts and when it quits (`removeClones`).
 * - A token goes only over https, in git's environment, never in a URL or an
 *   argument: the one the user's credentials hold for the host
 *   (`VcsCredentials.tokenForHost`).
 * - Every git it starts gets the git layer's environment (`gitSpawnEnv`):
 *   no prompt, ssh in batch mode, and no command a repository's own config
 *   names.
 * - A failure is a `RemoteSourceError` whose `url` is the source without the
 *   credentials typed into it, and whose message says what to do.
 */
import { randomUUID } from "node:crypto"
import path from "node:path"
import { Effect } from "effect"
import { gitSpawnEnv, resolveSshCommand } from "@runbooks/core/domain/git/env"
import { isGitLabHost } from "@runbooks/core/domain/git/gitlab-host"
import { githubHostKind, isGitHubHost } from "@runbooks/core/domain/git/github-host"
import { gitCredentialUsername, withGitHttpAuth } from "@runbooks/core/domain/git/url"
import { redactSecrets, registerSecret } from "@runbooks/core/domain/vcs/redact"
import { resolveRunbookPath } from "@runbooks/core/domain/workspace/file"
import type { FileWriteError, GitError, SpawnError } from "@runbooks/core/errors"
import { RemoteSourceError } from "@runbooks/core/errors"
import {
  parseRemoteSource,
  redactSourceCredentials,
  resolveRef,
} from "@runbooks/core/remote-source"
import { Environment } from "@runbooks/core/services/Environment"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { GitClient } from "@runbooks/core/services/GitClient"
import type { ProcessSpawner } from "@runbooks/core/services/ProcessSpawner"
import { VcsCredentials } from "@runbooks/core/services/VcsCredentials"

// ---------------------------------------------------------------------------
// Why a clone failed, and what the user can do about it
// ---------------------------------------------------------------------------

/**
 * An HTTP 401/403 as git reports it: "The requested URL returned error: 403",
 * "error: RPC failed; HTTP 401 curl 22 ...". A bare "401"/"403" also matches
 * the --progress counters ("Receiving objects: 89% (403/452)"), the clone's
 * path and repo names.
 */
const HTTP_AUTH_STATUS = /(?:returned error:\s*|\bhttp\s+)40[13]\b/

/**
 * Whether git's stderr reads as an authentication failure. As the Go CLI's
 * (beta-v0.9.0 cmd/remote_open.go isAuthError), an HTTP 404 or "repository
 * not found" counts: a private repo is a 404 to a client without access.
 *
 * Unlike the Go CLI, a bare "401"/"403" and any "permission denied" do not:
 * the stderr holds the `--progress` counters and the `Cloning into '<path>'`
 * line, so 401/403 must appear as an HTTP status, and "permission denied"
 * only in SSH's `Permission denied (<methods>)` form; a filesystem error
 * ends in `: Permission denied`.
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
    HTTP_AUTH_STATUS.test(lower) ||
    lower.includes("invalid credentials") ||
    lower.includes("bad credentials") ||
    lower.includes("permission denied (") ||
    lower.includes("terminal prompts disabled")
  )
}

/**
 * The environment variables that give `host` a token and the CLI login that
 * stores one, as the Go CLI's api.AuthHintForHost; undefined for a host that
 * is neither provider. Case does not matter.
 *
 * For a self-hosted GitLab the remedy names both halves: GITLAB_TOKEN alone
 * goes only to GITLAB_HOST's instance (gitlab.com by default). The same holds
 * for an enterprise GitHub host, whose token goes only to the host GH_HOST
 * names (GH_ENTERPRISE_TOKEN for GHES, GITHUB_TOKEN for a ghe.com tenant).
 *
 * `provider` is what the user's configuration says the host is: a GHES host
 * has an arbitrary name, so only that can place it. Without it, only
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

/** How a clone failed, and the hint the user sees. */
export interface ClassifiedCloneError {
  readonly kind: "auth" | "network" | "unknown"
  readonly hint: string
}

/** How a clone reaches its host. A token goes only over https. */
type Transport = "https" | "http" | "ssh"

/**
 * What a failed clone or ref lookup tells the user. The auth hints are the
 * Go CLI's (beta-v0.9.0 cmd/remote_open.go classifyCloneError):
 *
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
  provider?: "github" | "gitlab" | undefined
  /** How the clone reached the host; https when not given. */
  transport?: Transport | undefined
}): ClassifiedCloneError {
  const { host, owner, repo, stderr, hadToken, provider, transport } = opts
  const ssh = transport === "ssh"
  // A plain git source can name a repo with no owner (`git.corp.net/infra.git`).
  const repoPath = [host, owner, repo].filter(Boolean).join("/")
  const lower = stderr.toLowerCase()
  if (ssh && lower.includes("host key verification failed")) {
    return {
      kind: "auth",
      hint: `the SSH host key for ${host} is not trusted yet: connect to it once from a terminal to verify and save its key, or use an https:// URL`,
    }
  }
  // Before the auth check: after any ssh failure, a DNS error or a refused
  // connection included, git adds "fatal: Could not read from remote
  // repository.", which isAuthError counts. A stall is gitSpawnEnv's bound.
  const stalled = /transferred the last (\d+) seconds|timeout, server \S+ not responding/.exec(
    lower,
  )
  if (stalled !== null) {
    return {
      kind: "network",
      hint: `${host} ${stalled[1] === undefined ? "stopped answering" : `sent nothing for ${stalled[1]} seconds`}, so Runbooks gave up. Check your internet connection or proxy.`,
    }
  }
  if (
    lower.includes("could not resolve host") ||
    lower.includes("connection refused") ||
    lower.includes("connection timed out") ||
    lower.includes("connect to host") ||
    lower.includes("couldn't connect to server") ||
    lower.includes("network is unreachable")
  ) {
    return {
      kind: "network",
      hint: `Could not reach ${host}. Check your internet connection.`,
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
  return {
    kind: "unknown",
    // git's stderr can echo a URL with a token in it.
    hint: `failed to download runbook: ${redactSecrets(stderr) || "unknown error"}`,
  }
}

/** What git said when a step failed: its stderr, or why it did not start. */
function stderrOf(failure: GitError | SpawnError): string {
  if (failure._tag === "GitError") return failure.stderr
  return `${failure.command} could not start: ${failure.cause instanceof Error ? failure.cause.message : String(failure.cause)}`
}

// ---------------------------------------------------------------------------
// The clones folder
// ---------------------------------------------------------------------------

/** The folder, in the app's user data folder `userData`, that holds every clone. */
export const clonesFolder = (userData: string): string => path.join(userData, "v0", "clones")

/**
 * Removes `clones` and every clone in it; nothing when it is not there. Main
 * calls it when no session can have a runbook open from it: when the app
 * starts (the single-instance lock keeps any other app off the user data
 * folder) and when it quits, after the engine has stopped.
 */
export const removeClones = (clones: string): Effect.Effect<void, FileWriteError, FileSystem> =>
  Effect.gen(function* () {
    yield* (yield* FileSystem).rm(clones, { recursive: true, force: true })
  })

/** A Windows device name, with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/**
 * The folder a repo is cloned into: the repo's name, or "repo" for a name
 * that isn't a plain folder name. The name comes from the URL, so `..` or a
 * separator must not leave the clone's folder, and a name Windows reserves
 * for a device (`aux`, `con.txt`) can't be a folder there. The window names
 * a runbook at a repo's root after this folder.
 */
function cloneDirName(repo: string): string {
  const plain = /^[\w.-]+$/.test(repo) && repo !== "." && repo !== ".."
  return plain && !WINDOWS_DEVICE_NAME.test(repo) ? repo : "repo"
}

/** Who reads a clone's folder: its owner only. The repo may be private. */
const CLONE_FOLDER_MODE = 0o700

// ---------------------------------------------------------------------------
// Opening a remote source
// ---------------------------------------------------------------------------

/**
 * Clones the repository `source` names into a folder of its own in `clones`
 * and gives the runbook file it names there. The whole repository, not just
 * the runbook's folder: as with go-getter's `//` subdirectory, a runbook may
 * use other files in its repository, such as templates.
 */
export const resolveRemoteRunbook = (
  source: string,
  clones: string,
): Effect.Effect<
  string,
  RemoteSourceError,
  VcsCredentials | GitClient | ProcessSpawner | Environment | FileSystem
> =>
  Effect.gen(function* () {
    // What leaves this function carries the source without its credentials.
    const shown = redactSourceCredentials(source)
    const vcs = yield* VcsCredentials
    const fs = yield* FileSystem
    // Enterprise GitHub hosts the user configured (gh's hosts.yml, GH_HOST)
    // let a plain GHES repo URL parse as GitHub.
    const { configHosts, envHost } = yield* vcs.enumerateGitHubHosts()
    let parsed = yield* parseRemoteSource(source, {
      githubHosts: envHost ? [...configHosts, envHost] : configHosts,
    })
    const { host, owner, repo, cloneURL } = parsed

    // A token goes only over https: ssh authenticates with the user's keys,
    // and http would send it in the clear. The provider comes from names and
    // the user's own configuration, never "GitLab by default".
    const transport: Transport = cloneURL.startsWith("https://")
      ? "https"
      : cloneURL.startsWith("http://")
        ? "http"
        : "ssh"
    const provider = yield* vcs.detectProvider(host)
    const token = transport === "https" ? yield* vcs.tokenForHost(host) : undefined
    // Exact-match redaction catches a token no shape pattern knows (GitLab's
    // 64-hex OAuth tokens), wherever git echoes it.
    registerSecret(token)
    // GitHub takes `x-access-token`, GitLab (self-managed too) `oauth2`.
    const username = gitCredentialUsername(provider)

    const failWithHint = (failure: GitError | SpawnError) =>
      Effect.fail(
        new RemoteSourceError({
          url: shown,
          message: classifyCloneError({
            host,
            owner,
            repo,
            stderr: stderrOf(failure),
            hadToken: token !== undefined,
            provider,
            transport,
          }).hint,
        }),
      )

    // A browser URL spells ref and path as one string: split it against the
    // remote's branches and tags. A url.insteadOf rewrite can send even an
    // https URL over ssh, so the lookup runs the user's ssh client, as the
    // clone does.
    if (parsed.refAndPath !== undefined) {
      const environment = yield* (yield* Environment).getAll()
      const env = gitSpawnEnv(environment, yield* resolveSshCommand(environment))
      const resolved = yield* resolveRef(
        cloneURL,
        parsed.refAndPath,
        withGitHttpAuth(env, cloneURL, token, username),
      ).pipe(Effect.catch(failWithHint))
      const { refAndPath: _split, ...unsplit } = parsed
      parsed = { ...unsplit, ref: resolved.ref, path: resolved.path }
    }

    const folder = path.join(clones, randomUUID())
    yield* fs.mkdir(folder, { recursive: true, mode: CLONE_FOLDER_MODE }).pipe(
      Effect.mapError(
        (failure) =>
          new RemoteSourceError({
            url: shown,
            message: `could not make a folder for the clone in ${clones}: ${String(failure.cause)}`,
          }),
      ),
    )
    const dest = path.join(folder, cloneDirName(repo))
    const { ref, path: inRepo } = parsed
    const repoLabel = [host, owner, repo].filter(Boolean).join("/")
    const at = ref ? ` at ${ref}` : ""

    return yield* Effect.gen(function* () {
      yield* (yield* GitClient)
        .cloneSimple(cloneURL, dest, {
          ...(ref !== undefined ? { ref } : {}),
          ...(token !== undefined ? { token } : {}),
          username,
        })
        .pipe(Effect.catch(failWithHint))

      // A folder opens its runbook.mdx, a file opens as it is.
      const target = inRepo ? path.join(dest, inRepo) : dest
      if (!(yield* fs.exists(target))) {
        return yield* new RemoteSourceError({
          url: shown,
          message: `"${inRepo}" was not found in ${repoLabel}${at}`,
        })
      }
      const runbook = yield* resolveRunbookPath(target).pipe(
        Effect.mapError(
          () =>
            new RemoteSourceError({
              url: shown,
              message: `no runbook.mdx in ${inRepo ? `"${inRepo}"` : "the root"} of ${repoLabel}${at}`,
            }),
        ),
      )
      // The repo is untrusted: a symlink in it must not open a file outside the clone.
      if (!(yield* fs.isContainedInReal(runbook, dest))) {
        return yield* new RemoteSourceError({
          url: shown,
          message: `"${inRepo}" in ${repoLabel} points outside the repository`,
        })
      }
      return runbook
    }).pipe(
      Effect.onError(() => fs.rm(folder, { recursive: true, force: true }).pipe(Effect.ignore)),
    )
  })
