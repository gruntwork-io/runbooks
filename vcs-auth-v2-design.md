# VCS Auth v2 Design

**Status:** Draft
**Date:** 2026-06-10

**One-line summary:** the app makes all VCS API calls itself over a single direct-fetch transport, exactly like the golang beta-v0.9.0 app did, but the in-process transport is made to honor the OS trust store (plus glab's per-host `ca_cert` PEMs); `gh`/`glab` remain a *credential source*, a *login bootstrapper*, and — newly, narrowly — a *validation-only fallback probe* for trust stores Node cannot read. No new build tooling, no new npm dependencies.

All paths relative to `/Users/odgrim/dev/work/git/agents/runbooks/runbooks`.

---

## 1. Overview & goals

**The incident.** A customer's self-hosted GitLab presents a certificate signed by a custom root CA installed in the OS trust store. `git`, `gh`, and `glab` all work on that machine (libcurl/SecureTransport and Go's `crypto/x509` read the OS store). Runbooks fails at the very first step — token *validation* — because `src/layers/GitHubHttpClient.ts` and `src/layers/GitLabHttpClient.ts` use Node's global `fetch` (undici), which trusts only Node's bundled Mozilla CA list. A perfectly valid token read from glab's `config.yml` is reported as **"Invalid credentials detected"** (`electron/main/ipc/gitlab.ts:119` → `GitLabHttpClient.ts:141` → `web/src/components/mdx/GitAuth/GitAuth.tsx:246`). Two bugs, then: the TLS trust gap, and the *misdiagnosis* that renders a transport failure as a credential failure.

**The golang middle ground we are restoring** (verified against `git show beta-v0.9.0:api/remote_token.go`, `api/github_auth.go`):

- CLIs are a read-only token source consulted *after* env vars; the app never wraps `gh auth login`, never writes CLI config, never touches the keychain directly.
- Everything needing structured data or non-interactive reliability is a direct, tiny HTTP call (`GET /user`, PR create) — not `gh api` as the API layer, not an SDK.
- All git network transport goes through the system `git` binary (already true on `main`).
- TLS "just worked" because Go's `net/http` uses the OS trust store. **That property is the only thing the TypeScript port lost.** Token discovery, the multi-host dropdown, and GitHub auto-auth already exist on `main`.

**v2 goals**

1. **Step 0 (cherry-pickable hotfix):** restore system-trust TLS for every in-process HTTPS call from the Electron main process with a single additive startup mechanism (`tls.setDefaultCACertificates` union), keeping both HttpClient layers' code essentially intact. This alone fixes the customer incident for API calls *and* the OAuth device flow, for any CA installed **before app launch**.
2. **Tri-state validation outcomes** (`valid` / `invalid` / `unreachable`) so a TLS or network failure can never again surface as "Invalid credentials detected", and an unreachable host stops the credential chain instead of burning every source as invalid.
3. Unify the two credential resolvers (`src/domain/{github,gitlab}/auth.ts` vs the weaker `src/remote-source.ts:325-377`) behind one Effect service with the golang precedence rules.
4. Upgrade GitLab CLI reads from the current broken invocation (see §2.2 — `glab auth token` does not exist) to true per-host reads (`glab config get token --host H`), with glab-delegated OAuth refresh — *not* an in-app reimplementation of glab's OAuth.
5. Keep and extend the multi-instance dropdown (provenance badges, `hasCredential` annotation, persisted recents + last-selected host, "Other instance…" row); keep zero-click GitHub auto-auth.
6. First-class TLS error UX: classification, layered remediation, **mid-session trust refresh via an out-of-process cold read of the OS store** (Node caches the in-process system read for process lifetime — see §3.1; a naive in-process re-read can never observe a newly installed CA), and a narrow **CLI validation fallback** so machines where gh/glab work but Node's system-store reader comes up empty still authenticate.

**Non-goals:** GHES support (seam preserved, not built); a GitLab OAuth flow of our own; replacing the API layer with `gh api`/`glab api` (the CLIs are kept as a credential source, a *validation-only* fallback, and a documented support diagnostic — never the general transport); proxying API calls through the CLIs; system-proxy/PAC/NTLM support (deferred; escape route documented in §11).

**Hard-requirement scorecard (honest accounting):**

1. **Env vars + CLIs + config files loaded (§2)** — for github.com and all configured GitLab hosts, including `OAUTH_TOKEN` and a gh `hosts.yml` binary-absent fallback. **Explicitly excluded:** GHES hosts, `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN`, and gh secondary accounts (seam preserved, §11).
2. **GitLab multi-instance dropdown** — §4, including the 0–1-host and persistence cases.
3. **GitHub zero-click auto-auth** — §5, including an in-app re-detect path after a terminal `gh auth login`.
4. **Custom root CA in the OS trust store works end to end** — §3. macOS/Linux: API + OAuth + git, no user action when the CA is installed before launch; mid-session installs recover via the cold-read Retry. **Windows qualification:** the API/OAuth legs need no user action, but Git for Windows defaults to the OpenSSL backend which ignores the Windows certificate store — the git leg requires a one-time, in-app-offered, user-consented `git config --global http.sslBackend schannel` (§3.2). A residual macOS sliver (hostname-scoped/per-app Keychain trust) degrades to CLI-probe-validated auth + remediation card (§2.4, §11).
5. **No new tooling** — everything uses Electron 41 / Node 24 built-ins, the existing Effect `ProcessSpawner`/`Environment`/`FileSystem` services, Bun scripts, vitest, playwright. One *config* addition (a Node-environment vitest project for the integration suite, §9) — config, not tooling.

---

## 2. Credential resolution chain

One new Effect service, **`VcsCredentials`** (§6), is the single resolver used by the GitAuth IPC handlers, by git operations, and by the remote-runbook-open path (replacing `src/remote-source.ts:325-377`). The existing per-block `detectCredentials` prop (`false | ('env' | {env:{prefix}} | 'cli' | {block:id})[]`, first-success-wins) is preserved unchanged — note that `{env:{prefix}}` is today renderer-advertised but main-side dead (`web/.../GitAuth/types.ts:24` and `useGitAuth.ts:247` send a `prefix` the handler at `electron/main/ipc/github.ts:124` ignores); v2 implements it for real (§2.1).

### 2.0 Validation semantics — tri-state (the misdiagnosis fix)

Every detected token is validated with a direct `GET /user` before being accepted (golang behavior; explicitly not `gh api user` on the happy path — beta-v0.9.0 `api/github_auth.go:466-467`). The outcome is **tri-state**:

| Outcome | Trigger | Behavior |
|---|---|---|
| `valid` | 2xx | accept; main writes session env; success card |
| `invalid` | 401/403 | non-fatal warning chip per source; **continue** the chain. Copy never claims expiry for env tokens — a 401 cannot distinguish expired from wrong-host, so env-token chips read `"<VAR> is not valid for <host>"` |
| `unreachable` | `errorKind: "tls" \| "server-cert" \| "network"` (classifier, §3.1) | do **NOT** mark the token invalid. For `tls`: run the trust refresh (cold read, §3.1) once, retry; if still failing and a CLI is present, run the CLI validation fallback (§2.4); if all fail, **stop the chain** (every later source would hit the same wall) and surface the TLS card (§7). For `server-cert` (expired cert / hostname mismatch): no refresh, no probe — they cannot help; stop and surface the server-cert card. For `network`: stop and surface the network card. Never a token warning |

An *absent* token is silent fall-through. An empty final result is NOT an error (the repo may be public) — preserved from golang.

On `unreachable`, the renderer's `detectionStatus` still transitions to `'done'` and the error card renders **above the still-available manual UI** (the form-render gate at `GitAuth.tsx:254` requires `'done'`). PAT submission can still succeed via the §2.4 probe when the wall is TLS-only. On `network` (and on `tls` after refresh+probe both fail) the GitHub OAuth tab is disabled with an annotation ("github.com is unreachable — fix connectivity first") since the device flow would hit the same wall.

### 2.1 GitHub chain (host = github.com; GHES seam preserved, out of scope)

| # | Source | Mechanism | Absent | Invalid |
|---|--------|-----------|--------|---------|
| 1 | `GITHUB_TOKEN` env | `Environment.get` (existing `src/domain/github/auth.ts:87`). The `{env:{prefix}}` variant is **implemented main-side as new code**: `github:env-credentials` gains a `prefix?: string` param, validated in main against a new allowlist regex `^[A-Z][A-Z0-9_]*_$` (reject otherwise), looking up `<PREFIX>GITHUB_TOKEN`/`<PREFIX>GH_TOKEN` | try #2 | warn `GITHUB_TOKEN is not valid for github.com`, try #2 |
| 2 | `GH_TOKEN` env | same | try #3 | warn, try #3 |
| 3 | gh CLI | `gh auth token --hostname github.com`, 5s timeout via extended `detectCliToken` (`src/domain/git/cli-token.ts`). **Child env:** strip `GH_TOKEN`/`GITHUB_TOKEN` (so the CLI is a distinct source, not an echo of #1/#2); add `GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 NO_COLOR=1`. Exit 0 + stdout line = token; exit 1 / stderr `no oauth token found` / spawn ENOENT = absent. No network, parallel-safe. Covers keyring storage (since gh 2.26.0 the token usually lives in the OS keyring and `hosts.yml` contains none). **Behavior change vs `main`:** today's bare `gh auth token` (`src/domain/github/auth.ts:109-110`) returns the gh *default host's* token; the `--hostname github.com` pin is deterministic for multi-host gh configs and neutralizes `GH_HOST`. A user whose gh default is a GHES instance previously auto-authed (incorrectly) with a GHES token; they now land in the manual UI with the standard hint — document in release notes | try #3b | warn `GitHub CLI token is invalid or expired`, try #4 |
| 3b | gh `hosts.yml` direct parse | **gh-binary-absent-only fallback** (mirrors the glab #3 pattern; today `main` never parses hosts.yml under any condition, leaving a valid on-disk token unreachable when gh was uninstalled or isn't on the Finder-launched PATH). Paths: gh uses **exactly one** config dir — the first *defined* of `GH_CONFIG_DIR`, `$XDG_CONFIG_HOME/gh`, `~/.config/gh` — with **no fall-through past a defined-but-empty dir** (an early multi-candidate scan leaked another profile's `~/.config/gh` past a set `GH_CONFIG_DIR`; caught by e2e); read the `github.com` entry's `oauth_token`. If hosts.yml exists but holds no token (keyring storage) and gh is absent: hint `"gh stores this token in the OS keyring; install gh or paste a token."` Never parsed when the binary is present | try #4 | warn, try #4 |
| 4 | Block outputs `{block:'id'}` | existing renderer path; when the referenced block is a GitAuth block, resolution goes via the session env (§8); when it's any other block, the renderer-held value is validated as today | manual UI | warn |
| 5 | Interactive | OAuth device flow (Gruntwork client `Ov23liDbtds8EmGws3np`, scopes `["repo","read:org"]`) **kept available unconditionally — even when gh is installed**, or PAT paste | — | exact poll errors preserved (`expired_token` → "Authorization request expired. Please try again.", `access_denied` → "Authorization was denied by the user.") |

Notes:
- Precedence `GITHUB_TOKEN > GH_TOKEN` is the golang-tested order (beta-v0.9.0 `api/remote_token_test.go:9-26`). gh itself prefers `GH_TOKEN` (it exists precisely as the user's deliberate override of an ambient `GITHUB_TOKEN`). We keep the historical contract, **and** — because both-valid shadowing is otherwise silent — when both are set and differ, the success card / manual UI renders an explicit hint: `"GH_TOKEN is also set and differs; Runbooks used GITHUB_TOKEN — gh would use GH_TOKEN."` Open question in §11: flip in a future major.
- Scopes: from the `X-OAuth-Scopes` validation-response header (existing `GitHubHttpClient.ts:112`). For cli-source tokens, supplement with `gh auth status --hostname github.com` parsed by the golang-proven tolerant regex `/Token scopes?:\s*(.+)/` (quotes/singular/whitespace tolerated; failures ignored — scopes are advisory). Fine-grained PATs (`github_pat_`) legitimately have no scopes header — absence is not an error. Missing `repo` scope → warning `'Missing "repo" scope - some operations may fail'`, never a block.
- Token-type classification by prefix unchanged (`github_pat_`/`ghp_`/`gho_`/`ghs_`+`ghu_`); single copy lives in `src/domain/github/auth.ts` (delete the duplicate in `GitHubHttpClient.ts:140-146`).

### 2.2 GitLab chain (per selected host H — picker, authored `host` prop, or manual `instanceUrl`)

**Env-token host binding rule** (stated identically here, §4, and §8 — this replaces the contradictory gates in earlier drafts): the GitLab env tokens are bound to exactly **one** host, `envHost = normalize(GITLAB_HOST ?? GITLAB_URI ?? GL_HOST ?? "gitlab.com")`. Source #1 runs **only when H === envHost**; for any other picked host — glab-config hosts included, recents and session hosts included, authored hosts included — the chain starts at source #2 and the env token is **never transmitted**. This is a deliberate tightening of today's gate (gitlab.com + glab-config hosts, `src/domain/gitlab/auth.ts:103-106`, enforced at `electron/main/ipc/gitlab.ts:114-117`): it matches glab's own semantics (the env token targets the default/`GITLAB_HOST` instance, not every configured instance), it ends cross-origin token transmission (a gitlab.com PAT in `GITLAB_TOKEN` is never sent to `git.corp.example`'s `/user`), and it kills the spurious `"GITLAB_TOKEN is invalid or expired"` chip that today fires whenever the env token belongs to a different host than the one being detected. `isEnvTokenHostAllowed` is reworked to `envTokenHost(env)` + equality check.

| # | Source | Mechanism | Absent | Invalid |
|---|--------|-----------|--------|---------|
| 1 | `GITLAB_TOKEN`, then `GITLAB_ACCESS_TOKEN`, then `OAUTH_TOKEN` env | `Environment.get`, only when H === envHost (rule above). Order is glab's own documented precedence — **`OAUTH_TOKEN` is a real, glab-honored credential** (legacy but supported) that earlier drafts both skipped and stripped from child env, stranding OAUTH_TOKEN-only users in the manual UI. All three are validated Bearer-first (§3.3) | try #2 | warn `<VAR> is not valid for <envHost>`, try #2 |
| 2 | glab CLI per-host | **`glab config get token --host H`**, 5s timeout. (This *replaces a latent dead path on `main`*: `src/domain/gitlab/auth.ts:80` invokes `glab auth token`, a subcommand that does not exist — gh has `auth token`, glab does not — so it always exited non-zero and was treated as absent. There has never been a working glab-CLI source to regress; note this in hotfix release notes/QA.) **Child env:** strip `GITLAB_TOKEN`/`GITLAB_ACCESS_TOKEN`/`OAUTH_TOKEN` (they override per-host reads inside glab) **and `NO_PROMPT`** — never set it: it is deprecated in glab (observed at 1.101.0), and setting it makes glab print a warning **on stdout** ahead of every payload we parse (the contract-(a) token, `api user` JSON). Add `GLAB_CHECK_UPDATE=false GLAB_SEND_TELEMETRY=false GLAB_NO_PROMPT=true NO_COLOR=1` (`GLAB_CHECK_UPDATE=false` semantics and the `NO_PROMPT` strip are pinned by stub-shim test; all spawns are non-interactive with timeouts so a prompt/update check can never hang the read regardless). **Exit contracts (all three pinned by stub-shim tests):** (a) exit 0 + token on stdout = token (first non-empty stdout line); (b) exit 0 + **empty stdout** = host not configured, never an error; (c) **exit 1 + stderr containing `not found in keyring`** = keyring-blocked — glab IS installed but the OS keyring is locked/unreadable; distinct copy: `"glab stores this token in the OS keyring but could not read it — unlock your keyring or paste a token."` Covers keyring-stored tokens (`use_keyring`): glab's config layer (schema `Keyring: true`, `Config.GetWithSource` keyring path, legacy `glab:<host>` key) reads the keyring on `config get token`; a known keyring regression window (glab issue #8168, v1.84.0–≥v1.85.2) is noted in §11 and degrades through contract (c). **All glab spawns serialized through a per-host `Effect.Semaphore`** (glab rewrites config.yml with no file locking). OAuth staleness handled below | try #3 | warn `glab token for <H> is invalid or expired`, try #3 |
| 3 | glab `config.yml` direct parse | existing `detectConfigCredentials(H)` (`src/domain/gitlab/auth.ts:278`) with `!!null`-tag stripping and glab's 4-path directory precedence (`GLAB_CONFIG_DIR` → legacy `~/.config/glab-cli` → `$XDG_CONFIG_HOME/glab-cli` → platform default, macOS `~/Library/Application Support/glab-cli`) — kept **only as the glab-binary-absent fallback**. Keyring-only configs with glab absent: `"glab is configured to store tokens in the keyring; install glab or paste a token"` — the `install glab` phrasing is reserved for this binary-absent path only | try #4 | warn, try #4 |
| 4 | Block outputs | as GitHub #4 | manual UI | warn |
| 5 | Manual PAT + instance-URL field | existing `PatForm.tsx` → `gitlab:validate` | — | inline error with HTTP status |

**OAuth staleness — delegated to glab, only the *check* in-app.** glab's gitlab.com logins are OAuth2 with 2-hour expiry; `glab config get token` does **not** refresh. We do not reimplement the refresh. New helper `readGlabHostMeta(yaml, H)` in `src/domain/gitlab/auth.ts` returns `{ isOAuth2, oauth2ExpiryDate, caCert }` from config.yml. Source #2 then becomes:

1. Read meta. If `isOAuth2 && oauth2ExpiryDate < now + 60s` → run `glab auth status --hostname H` (10s timeout, all output on **stderr**, network call) purely as a side effect to make glab refresh-and-rewrite its config, then re-run `glab config get token --host H`. Both spawns go through the per-host semaphore so we never race glab's own rewrite.
2. If glab is missing or the refresh fails → treat as absent with warning `GitLab CLI token for <H> has expired. Run 'glab auth login --hostname <H>' to refresh.`
3. If the returned token still validates as `invalid` → same warning, fall through.

`glab auth status` exit-1 ambiguity is disambiguated by stderr text: `No token found (checked config file, keyring, and environment variables)` → not-logged-in; `API call failed: ...` → instance/transport problem — never conflated in error copy (§7).

### 2.3 Unified host→token resolution (kills the second resolver)

`VcsCredentials.tokenForHost(host)` — used by remote-runbook open (`electron/main/remote.ts`) and any future host-keyed caller — **replaces `src/remote-source.ts:325-377` (`getTokenForHost`/`tryCliToken`), which are deleted**:

1. Consult the **session env first** (provider-keyed, matching `getSessionTokenForProvider` in `electron/main/ipc/runtime.ts:49-60`) so a token established by a GitAuth block is reused.
2. `host === "github.com"` → GitHub chain #1–#3b.
3. `host` is gitlab.com, OR **a member of the §4 host union** (glab config hosts + env hosts + session host + recents), OR matches the legacy `isGitLabHost` name heuristic → GitLab chain #1–#3 for that host (env source #1 still subject to the host-binding rule). Union membership — not the name heuristic — is the gate, fixing the `git.corp.net` blind spot.
4. Otherwise → `undefined` (not an error; public repos must work).

Successful CLI reads are cached in-memory per `(binary, host)` for 5 minutes (shortened from golang's process-lifetime cache because glab OAuth tokens rot in 2h). **Invalidation:** any auth failure, and **any renderer-initiated re-detection** — the HostSelect Reload, the GitHub "Check again" control (§5), and an explicit host pick — flushes the relevant `(binary, host)` entry, so a terminal `gh auth switch`/re-login is picked up on demand rather than after TTL.

### 2.4 CLI validation fallback (narrow, deterministic, validation-only)

Addresses the one correctness gap in the direct-API design: Node's young system-CA reader (24.5+) skips macOS hostname-scoped/per-app trust and odd MDM stores — machines where gh/glab/git "just work" but the union comes up empty. When `validateToken` fails with `errorKind: "tls"` **after** the trust-refresh retry (§3.1) and the relevant CLI is installed and meets the version floor (gh ≥ 2.26.0, glab ≥ 1.75.0, probed via `vcs:cli-status`, §6):

- **GitHub:** spawn `gh api user -i` with child env `GH_TOKEN=<candidate>` (pins gh to validate exactly the token in hand, not its ambient store; both CLIs document env-over-stored-creds), `GITHUB_TOKEN` stripped, hygiene vars set. `-i` exposes headers, so `X-OAuth-Scopes` still yields scopes. 10s timeout.
- **GitLab, `glpat-`-shaped tokens:** spawn `glab api user --hostname H` with child env `GITLAB_TOKEN=<candidate>` (other token env vars stripped, hygiene vars set, per-host semaphore).
- **GitLab, OAuth-shaped tokens (unprefixed 64-hex):** never probed via token env injection — glab may send an env-injected `GITLAB_TOKEN` as `PRIVATE-TOKEN`, which OAuth tokens reject; a spurious 401 would corrupt the tri-state. Instead, **when the candidate's source is glab itself** (CLI read or config parse — i.e. glab's stored credential IS the candidate), run `glab auth status --hostname H` (exit code + stderr text, **no token env injection**, so the header mismatch never arises) as the probe: success → `valid` + transport-degraded; `No token found` → absent; `API call failed` → TLS card. This converts the former dead-end TLS card for the OAuth sliver into probe-validated degraded auth. Env-sourced OAuth-shaped tokens stay direct-fetch-only.
- **On success:** outcome `valid`; auth is accepted and session env written as usual; the success card gains a transparency line — *"validated via glab CLI — Runbooks' direct connection to `<H>` is not trusted yet"* — linking the TLS remediation card (§7). The host is marked transport-degraded in memory: subsequent direct API calls for it (labels, MR create) short-circuit to the TLS card with precise copy ("glab can reach this host; Runbooks cannot — the CA is likely hostname-scoped in Keychain; set it to Always Trust"). git operations are unaffected. A structured log line `transport degraded for <host>: <code>` doubles as a support signal and a field canary for Node system-store-reader regressions.
- **On any CLI-probe failure class** — spawn ENOENT, timeout, parse failure, unexpected exit semantics after a CLI upgrade, stderr `API call failed` — the probe degrades to the TLS/network card. A broken probe never masks the working remediation path, and a working direct transport is never hidden behind a broken probe.

This is **not** a general CLI transport: orgs/repos/refs/labels/PR/MR keep exactly one transport (direct fetch). `gh api`/`glab api` remain documented as a support *diagnostic* beyond this single validation probe.

---

## 3. Transport & TLS strategy

### 3.0 Step-0 hotfix (shippable alone, cherry-pickable single PR)

In `electron/main/index.ts`, immediately after `populateShellEnv()` (line 31) and **before** `registerAllIpcHandlers()`, `initAutoUpdater()`, or any TLS connection:

```ts
import * as tls from "node:tls"
// Snapshot the bundled defaults BEFORE the first setDefaultCACertificates:
// afterwards getCACertificates("default") returns the previously-installed
// union, so re-reading "default" later would compound extras into the base.
const bundledDefaults = tls.getCACertificates("default") // Mozilla roots + NODE_EXTRA_CA_CERTS
// NOTE: getCACertificates("system") is cached for process lifetime (Node 24
// lib/tls.js: `systemCACertificates ||= ObjectFreeze(...)`). Fine at launch;
// mid-session refresh needs a cold out-of-process read — see system-ca.ts (§3.1).
// CAVEATS (keep these comments): per-thread — must be repeated in any future
// worker_threads/utilityProcess (none exist today); must precede the first
// cacheable TLS connection.
tls.setDefaultCACertificates([...bundledDefaults, ...tls.getCACertificates("system")])
```

This fixes the customer incident for API calls **and** the OAuth device flow in one additive, dependency-free change — public sites keep working from the bundled roots; the enterprise CA arrives from the `"system"` read (macOS: Default/System Keychain certs with Always-Trust; Windows: LM + CU Trusted Roots incl. Group Policy; Linux: distro OpenSSL paths). Verified empirically inside the repo's Electron 41.1.1 binary (Node 24.14.0): bare `fetch` fails `UNABLE_TO_VERIFY_LEAF_SIGNATURE` → after the union, succeeds; public CAs keep working.

**Blast radius (per-call-site truth for future auditors):** this fixes every *Node*-TLS client in main — the two VCS HttpClient layers, the OAuth device flow, the AWS SDK layers (`node:https`), and `src/layers/MixpanelTelemetry.ts` (the mixpanel Node package over `node:https`, registered via `electron/main/ipc/telemetry.ts`) behind TLS-intercepting corporate proxies. electron-updater (Electron `net` module) and all renderer traffic ride Chromium's network stack and are OS-trusted independently of this change. It requires **zero changes** inside `GitHubHttpClient.ts`/`GitLabHttpClient.ts` (verified: both are dependency-free `Layer.succeed` over global fetch). Ship this first regardless of everything else.

Why the alternatives are dead ends (per the TLS study): `NODE_OPTIONS=--use-system-ca` is stripped in packaged apps; `NODE_USE_SYSTEM_CA=1` must pre-exist at launch (Finder launches won't have it); a custom undici Agent needs a dependency the repo doesn't have plus dispatcher plumbing through both layers.

### 3.1 The mechanism, made refreshable and harvest-aware

Step 0's inline call is refactored (migration step 1) into a pure, injectable module `src/domain/tls/system-ca.ts`:

```ts
export interface CaSources {
  bundledDefaults: () => string[]          // the startup snapshot — never re-read "default"
  systemPems: () => Effect<string[]>       // launch: in-process getCACertificates("system");
                                           // refresh: cold out-of-process read (below)
  setCAs: (certs: string[]) => void        // tls.setDefaultCACertificates
}
/** Union bundled-default snapshot with OS-installed roots plus any extra PEMs
 *  (glab per-host ca_cert contents, test seam), dedupe, install as the
 *  process-default CA list. Returns counts for logging. Idempotent; safe to re-run. */
export function installSystemTrust(extraPems: string[], io: CaSources): Effect<{ defaults: number; system: number; extra: number }>

export function classifyTlsError(err: unknown): "tls" | "server-cert" | "network" | undefined
// Unwraps the cause chain FIRST: undici's global fetch rejects with
// TypeError("fetch failed") carrying the OpenSSL code on error.cause,
// sometimes nested inside AggregateError.errors — without unwrapping,
// everything classifies as undefined. Fixtures in system-ca.test.ts are
// undici-shaped, not bare Error objects.
// "tls" (trust-store fixable → refresh + probe + CA-install card):
//        UNABLE_TO_GET_ISSUER_CERT_LOCALLY, SELF_SIGNED_CERT_IN_CHAIN,
//        UNABLE_TO_VERIFY_LEAF_SIGNATURE, DEPTH_ZERO_SELF_SIGNED_CERT
//        (+ Chromium ERR_CERT_AUTHORITY_INVALID should net.fetch ever be adopted)
// "server-cert" (NOT fixable by trust changes → admin card, no refresh/probe):
//        CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID
// "network": ENOTFOUND, ECONNREFUSED, ETIMEDOUT, EAI_AGAIN
```

**Trust refresh = cold read, out of process.** Node 24 caches `getCACertificates("system")` for process lifetime and `setDefaultCACertificates` resets only the *default* cache (`lib/tls.js:136-180`) — verified empirically in the shipped Electron binary (first call 9.7ms real Keychain query; next 100 calls 0.018ms total, frozen array). An in-process re-read can therefore **never** observe a CA installed after launch. The refresh path instead spawns a short-lived child via the existing `ProcessSpawner` service: `process.execPath` with env `ELECTRON_RUN_AS_NODE=1` and args `["-p", "JSON.stringify(require('node:tls').getCACertificates('system'))"]`, 10s timeout. A fresh process has an empty cache and performs a real OS-store query; its parsed stdout becomes `systemPems` for `installSystemTrust`. Zero new dependencies; fits the Effect DI pattern; testable with the §9 stub-shim approach. **Fallback:** on any child failure (spawn error, timeout, unparseable stdout), fall back to the launch-time cached set (never worse than launch) and switch the TLS-card copy for that attempt to "…then restart Runbooks".

Refresh runs: (a) automatically, once, on every TLS-classified validation failure before any error surfaces; (b) on **Retry** in the TLS error card; (c) on HostSelect **Reload** and the GitHub **Check again** control. This makes the "IT just pushed the CA mid-session" flow genuinely work without relaunch.

**glab `ca_cert` harvesting.** During host enumeration (§4), `readGlabHostMeta` collects per-host `ca_cert` PEM paths from glab's config.yml; their file contents are passed as `extraPems` to `installSystemTrust` (plain file reads — no caching concerns). Environments where the CA exists *only* in a PEM referenced by glab config succeed silently, with no error card and no subprocess transport. `skip_tls_verify` is deliberately **never** honored — we never disable verification.

**Escape hatch (documented, already works):** `NODE_EXTRA_CA_CERTS=/path/ca.pem` at launch (merged into the bundled-defaults snapshot automatically; gated only on the default-enabled nodeOptions fuse). Surfaced as the advanced remediation in the TLS card; never the default UX.

### 3.2 Per-call-site coverage

| Call surface | Transport | Change |
|---|---|---|
| GitHub API (validate, orgs/repos/refs/labels, PR create) | global `fetch` in `GitHubHttpClient.ts` | none — fixed by §3.0/§3.1 (matters for TLS-intercepting proxies even though the host is github.com) |
| GitLab API (validate, scopes, MR create, labels) — **the customer failure** | global `fetch` in `GitLabHttpClient.ts` | Bearer-first header order (§3.3) + `errorKind` classification; otherwise none |
| OAuth device flow (`github.com/login/device/code`, `/login/oauth/access_token`) | global `fetch` (existing state machine) | none — kept in-app and **kept available even when gh is installed**; fixed by §3.0 |
| Token validation under TLS-classified failure | `gh api user -i` / `glab api user --hostname H` / `glab auth status --hostname H` subprocess (validation-only fallback, §2.4) | new, narrow |
| `git clone/push/ls-remote` | system `git` binary | **macOS** (Apple git → SecureTransport) and **Linux** (distro bundle includes OS-installed CAs): already OS-trusted, no change. **Windows: NOT OS-trusted by default** — the Git-for-Windows installer's default HTTPS backend is OpenSSL with its own bundled `ca-bundle.crt`; the Windows certificate store is only consulted under the opt-in Schannel backend. Mitigation is **proactive**: on Windows, `vcs:cli-status` also reads `git config --get http.sslBackend` and `git version --build-options` (cheap subprocesses, no config writes); when the backend isn't schannel and a non-public GitLab host is selected, the auth success card / clone preflight surfaces "run `git config --global http.sslBackend schannel`" **before** the first clone, with an optional consented one-click apply (explicit button press — never silent). **Hygiene pinned by test:** `gitSpawnEnv()` must never set `GIT_SSL_NO_VERIFY`, `GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`, `CURL_CA_BUNDLE`, `SSL_CERT_FILE`, `SSL_CERT_DIR` (clean today; regression test added) |
| `gh`/`glab` credential-read subprocesses | Go binaries → OS store | none |
| Renderer | IPC-only (verified — no VCS fetches under `web/src`) | none. Self-hosted avatars: **initials-avatar fallback** in `AuthSuccess`/`HostSelect` — the production CSP `img-src` allowlist at `electron/main/window.ts:81` is **not** widened per instance (no new security surface) |

**`net.fetch` is not adopted for the API layers in v2.** Reasons grounded in this repo: the unfiltered CSP `onHeadersReceived` injector on `session.defaultSession` (`electron/main/window.ts:75-86`) would run on every API response; layers are built under Bun/vitest where `electron` is unavailable; `Response.url` deviations. It is reserved, in code comments, as the pre-designed escape route for system-proxy/PAC/NTLM customers — a problem `setDefaultCACertificates` cannot solve — behind a fetch-shaped `VcsHttp` seam if/when such a customer materializes (§11). **Cheap insurance shipped now:** add a URL filter to the `onHeadersReceived` CSP injector so it only decorates app-window origins — mandatory the moment `net.fetch` is ever used in main, harmless today.

### 3.3 Header schemes

- **GitHub:** `Authorization: Bearer <t>` — already used; accepted for all token prefixes. No change.
- **GitLab:** flip `gitlabFetch`/`validateUserToken` to **Bearer-first** (works for both `glpat-` PATs and glab's unprefixed 64-hex OAuth tokens), retrying once with `PRIVATE-TOKEN` on 401 for old self-hosted instances. Today PRIVATE-TOKEN always 401s first for glab OAuth users — Bearer-first halves the common-case round trips and makes zero-click GitLab auth visibly faster. Scope introspection keyed on token shape: `glpat-` → `/api/v4/personal_access_tokens/self` (**requires GitLab ≥ 15.5** — the `self` keyword landed in 15.5; older instances 404, which is silently treated as "no scope info" and pinned by test), otherwise `/oauth/token/info` (Bearer); both remain best-effort enrichment.

### 3.4 What we own — honest accounting

`GitHubHttpClient.ts` is unchanged except deleting the duplicated `detectTokenType` and adding `errorKind` classification. `GitLabHttpClient.ts` changes only the header order and classification. The cost of this angle: we keep owning validation endpoints, pagination, scope-introspection quirks, the device-flow state machine, and the glab staleness check — ~600 LOC that already exists and is already tested on `main`. The marginal new surface is one TLS module (including the cold-read refresh child), one `VcsCredentials` service (which *deletes* a resolver), per-host glab reads, and a single CLI validation probe. One transport, one test matrix.

---

## 4. GitLab multi-instance UX

The dropdown exists (`HostSelect.tsx`); v2 widens discovery, labels provenance, fixes persistence, and makes the picker reachable in the common single-host case.

**Discovery & merge** — `gitlab:enumerate-hosts` result becomes:

```ts
{
  hosts: Array<{
    host: string
    sources: Array<"glab" | "env" | "session" | "recent">  // provenance badges
    hasCredential: boolean                                   // offline-only check
  }>
  defaultHost: string
}
```

Merged in order, deduped by normalized host (`normalizeGitLabBaseUrl`):

1. **glab config hosts** — existing `detectConfigHosts()` (keys of `hosts:` across all 4 config-path candidates).
2. **env** — `GITLAB_HOST`, then `GITLAB_URI`, then `GL_HOST` (glab's own precedence), when set.
3. **session** — `GITLAB_HOST` from the current session env (authenticated earlier this run).
4. **recent** — `app.getPath("userData")/vcs-auth.json`: `{ recentGitLabHosts: string[]; lastSelectedGitLabHost?: string }` (**hostnames ONLY, never tokens**). `recentGitLabHosts` is most-recent-first, max 5, evicted from the tail; appended when a manually-typed `instanceUrl` validates successfully. `lastSelectedGitLabHost` is written by main on **every successful GitLab auth and every explicit dropdown pick (any source, not just manual URLs)** — this is what makes a pick survive restart. New module `electron/main/recent-hosts.ts`.

`hasCredential` is computed **offline only** — env-token presence (counted **only** for `envHost` per the §2.2 binding rule), config.yml token or `use_keyring` marker — no network and no per-host subprocess fan-out on the mount path. The key icon's tooltip is **"credential found (not yet validated)"**; if a pick's detection subsequently ends `invalid` or keyring-blocked, the row's icon is downgraded/annotated for the remainder of the session so the dropdown never contradicts the warning chip. Hosts without a credential get a subtle "no credentials — paste a token" hint — **also rendered in the non-dropdown single-host layout** (next to the Reload control), keyed off the same annotation.

`defaultHost` precedence (matching glab's env-over-config semantics): authored `host` prop (pins instance, hides picker — existing) > **persisted `lastSelectedGitLabHost`** (honored only when still present in the union AND `hasCredential` — a credential-less stale pick must not steal auto-detect from a working gitlab.com token) > env `GITLAB_HOST`/`GITLAB_URI`/`GL_HOST` > glab's top-level `host:` > `gitlab.com`. **The persisted pick is restored on restart.** The in-memory `userPickedHostRef` (`useGitAuth.ts:102`) still tracks the live session; recents/lastSelected seed the initial value.

**Dropdown flow** (`web/src/components/mdx/GitAuth/`):

1. On mount, `useGitAuth` calls `gitlab:enumerate-hosts`; detection defers until `hostsReady` (existing). Enumeration also triggers the `ca_cert` harvest (§3.1).
2. **The select renders whenever `hostSelectable` and there is at least one known host** (`hasChoice` in `HostSelect.tsx:25` becomes `hosts.length >= 1`) — entries plus the "Other instance…" row. This makes the row reachable in the majority case (gitlab.com-only), which the previous `> 1` gate made impossible. With zero known hosts, the manual UI keeps the instance-URL field as today.
3. **"Other instance…"** row uses a sentinel option value (`"__other__"`) **intercepted in the renderer before `changeHost`** (`useGitAuth.ts:716-722` treats every value as a real host): selecting it reveals the instance-URL field, does **not** alter `selectedHost`, does **not** run detection, and reverts the select to its prior value. A never-configured instance is one click away instead of buried in the PAT tab.
4. Picking a real host runs the §2.2 chain for that host (env source subject to the binding rule). Success → `GITLAB_TOKEN` + `GITLAB_HOST` written to session env **by main** (§8) → `AuthSuccess` with the instance host; main persists `lastSelectedGitLabHost`. Picker stays visible post-auth when multiple hosts exist (existing).
5. **Reload** re-runs enumeration, invalidates the CLI token cache, clears any transport-degraded flag, and re-runs `installSystemTrust` **with the cold-read refresh** — the documented path after `glab auth login --hostname new.host` in a terminal *or* after installing a CA mid-session.
6. Manual `instanceUrl` successes enter `recent` and appear in the dropdown next time.
7. Avatars: initials/generic-mark fallback for self-hosted instances (no CSP change).
8. **Renderer host-shape change:** the enumerate result is now objects; the reconciliation logic in `useGitAuth.ts:346-348` (`hosts.includes(prev)`, `hosts[0]`) must compare against `hosts.map(h => h.host)`.
9. **Two GitLab blocks, two instances (degraded, fix deferred — §11):** session env holds a single `GITLAB_TOKEN`/`GITLAB_HOST` pair, so a second block authenticating a different host silently replaces the first block's session credential. Specified degraded behavior: main pushes a `vcs:session-changed` event on every session write; an `AuthSuccess` card whose host no longer matches the provider's `{host, source}` metadata (runtime.ts map, §6) renders a **stale-session warning** instead of implying its credential is still active.

---

## 5. GitHub auto-auth (zero-click happy path)

Existing behavior preserved exactly; v2 makes its TLS reliable, its provenance visible, and adds an in-app re-detect path.

1. Runbook mounts `<GitAuth provider="github">`; default `detectCredentials=['env','cli']`.
2. Once the session is ready, `useGitAuth` runs detection with **no user action**: `github:env-credentials`, then `github:cli-credentials`.
3. During detection, the **inline pending indicator in `GitAuth.tsx:205-214`** shows "Checking for existing authentication..." (note: `AutoAuthInfo.tsx` is the collapsible "How can I authenticate automatically?" FAQ under the manual form, not a spinner; its copy is updated to reference the new "Check again" control instead of "reload the runbook"). The source/transport lines below belong to `AuthSuccess.tsx`.
4. First `valid` source → main writes `GITHUB_TOKEN` + `GITHUB_USER` to session env and returns metadata; renderer renders `AuthSuccess`: avatar (or initials), login, token-type chip, scopes, missing-`repo`-scope warning if applicable, a **source line** — "Detected from `GITHUB_TOKEN`" / "Detected from GitHub CLI (gh)" — the both-env-vars-set divergence hint when applicable (§2.1), plus, when the §2.4 fallback engaged, "validated via gh CLI". Zero clicks.
5. `invalid` outcomes → non-fatal warning chips above the manual UI; chain continues. `unreachable` → no "invalid" lie; the TLS/server-cert/network card shows instead (§7), with the manual UI still rendered beneath it (§2.0).
6. Nothing found → manual UI (OAuth device-flow tab + PAT tab), with hint copy driven by `vcs:cli-status` (§6): gh installed-not-authed → "Tip: run 'gh auth login'…"; gh absent → "Tip: install the GitHub CLI…". The device flow remains a first-class tab in both cases.
7. **Check again (new):** the manual UI renders a "Check again" control next to the `vcs:cli-status` hint line, wired to the existing `reloadDetection()` (`useGitAuth.ts:693-703`, which resets `detectionAttemptedRef`) plus `VcsCredentials.invalidateCache()` plus the trust refresh. This is the in-app path for "I just ran `gh auth login` in a terminal" — today the only recovery is reloading the whole runbook. **Recommended addition:** re-run detection automatically on window focus when `detectionStatus === 'done' && authStatus !== 'authenticated'` (debounced), making the terminal-login flow genuinely zero-click.

GHES notes (out of scope, stated for clarity): `GH_HOST` is neutralized by the `--hostname github.com` pin; a GHES token in `GH_TOKEN`/`GITHUB_TOKEN` 401s against api.github.com and produces the `"<VAR> is not valid for github.com"` chip (§2.0 wording — never "expired"); GHES-configured users land in the manual UI with the standard hint until the GHES seam is built.

---

## 6. Architecture mapping

Existing idioms followed exactly: `Context.Tag` interfaces in `src/services/`, `Layer.effect`/`Layer.succeed` implementations in `src/layers/`, composition in `src/layers/AppLayer.ts`, one `ManagedRuntime` in `electron/main/ipc/runtime.ts`, typed channels in `electron/shared/channels.ts`, renderer IPC-only.

### New files

| File | Contents |
|---|---|
| `src/domain/tls/system-ca.ts` | `installSystemTrust(extraPems, io)`, `dedupePems`, `classifyTlsError` (with cause-chain unwrapping), cold-read child-spawn helper (§3.1); injectable `CaSources` for tests |
| `src/services/VcsCredentials.ts` | `Context.Tag` interface: `resolveGitHub(prefix?): Effect<DetectionResult>`, `resolveGitLab(host): Effect<DetectionResult>`, `tokenForHost(host): Effect<string \| undefined>`, `enumerateGitLabHosts(): Effect<MergedHosts>`, `validateViaCli(provider, host, token, source): Effect<CliValidation, VcsCliError>` (§2.4), `cliStatus(): Effect<{gh: CliStatus; glab: CliStatus; git?: GitTlsStatus}>`, `invalidateCache(): Effect<void>`. `DetectionResult = { outcome: "valid" \| "invalid" \| "unreachable" \| "absent"; token?: string; source?: "env" \| "cli" \| "config"; user?; scopes?; warnings: string[]; errorKind?: "tls" \| "server-cert" \| "network" }` (token stays main-side; see §8 for what crosses IPC) |
| `src/layers/VcsCredentialsLive.ts` | `Layer.effect(VcsCredentials, …)` depending on `Environment`, `ProcessSpawner`, `FileSystem` (composed with `Layer.provide` in AppLayer, like `GitCliClientLive`). Owns: the per-(binary,host) 5-min token cache + invalidation rules (§2.3), the per-host glab `Effect.Semaphore`, child-env hygiene (strip/set lists incl. `OAUTH_TOKEN`), CLI version probe cache (`/gh version (\d+\.\d+\.\d+)/`, `/glab (\d+\.\d+\.\d+)/` — loose for older `glab version X.Y.Z`), the Windows `git config --get http.sslBackend` probe, the §2.4 probe, the transport-degraded host set |
| `electron/main/recent-hosts.ts` | read/write `vcs-auth.json` (`recentGitLabHosts` most-recent-first + `lastSelectedGitLabHost`; hostnames only) under `app.getPath("userData")` |
| `src/domain/vcs/redact.ts` | `redactSecrets(s)` (§8) |
| `web/src/components/mdx/GitAuth/components/TlsErrorCard.tsx` | TLS remediation card with Retry; also renders the server-cert and network variants (§7) |
| `vitest.integration.config.ts` + `test/integration/` | **new Node-environment vitest project** scoped to `test/integration/**` (§9 — this does *not* exist today; the root `vitest.config.ts` is a re-export of web's jsdom config) |
| Tests/fixtures | `src/domain/tls/system-ca.test.ts`, `test/integration/tls-custom-ca.test.ts`, `test/fixtures/tls/*` (committed CA + localhost leaf), `scripts/gen-tls-fixtures.sh`, `test/fixtures/vcs-cli/{gh,glab}` stub shims, `docs/qa/custom-ca-release-gate.md` |

### Modified files

| File | Change |
|---|---|
| `electron/main/index.ts` | Step-0 union with bundled-defaults snapshot (later: `installSystemTrust` call right after `populateShellEnv()`, line 31); export async `refreshSystemTrust()` (cold read) used by handlers on TLS failure/Retry/Reload/Check-again; log the `{defaults, system, extra}` counts at launch (e2e canary, §9) |
| `electron/main/window.ts` | URL filter on the `onHeadersReceived` CSP injector (app-window origins only); **no** `img-src` widening |
| `package.json` (+ CI workflow) | add `test:integration` (vitest, Node env, `test/integration/**`); add `--path-ignore-patterns='test/**'` to `test`/`test:backend` so `bun test` never discovers the integration suite (Bun 1.3.x lacks `tls.setDefaultCACertificates`); wire `test:integration` into CI on the Node runner |
| `src/domain/gitlab/auth.ts` | `detectCliCredentialsForHost(host)` (per-host read + hygiene + three exit contracts), `readGlabHostMeta(yaml, host)` (`is_oauth2`, `oauth2_expiry_date`, `ca_cert`), `refreshOAuthViaGlab(host)`; `envTokenHost(env)` replacing `isEnvTokenHostAllowed` (§2.2 binding rule); add `OAUTH_TOKEN` to env detection; keep `detectConfigCredentials` as binary-absent fallback; `enumerateHosts()` returns the annotated union |
| `src/domain/github/auth.ts` | `detectCliCredentials()` → `gh auth token --hostname github.com` with env stripping + hygiene vars; prefixed-env lookup with the new `^[A-Z][A-Z0-9_]*_$` allowlist (new code — see §2.1); `detectHostsYmlCredentials()` binary-absent fallback; `cliScopes()` via the status regex; remains the single home of `detectTokenType` |
| `src/domain/git/cli-token.ts` | `detectCliToken(cmd, args, timeout, envOverrides?: { unset: string[]; set: Record<string,string> })` |
| `src/layers/GitLabHttpClient.ts` | Bearer-first (§3.3); wrap fetch errors through `classifyTlsError` into `GitLabApiError` (new optional `kind?: "tls" \| "server-cert" \| "network"`) |
| `src/layers/GitHubHttpClient.ts` | drop duplicated `detectTokenType`; same `kind` classification on `GitHubApiError` |
| `src/errors/index.ts` | optional `kind` on both API error classes; new `VcsCliError` (`Data.TaggedError` carrying `kind: "not-installed" \| "not-authenticated" \| "keyring-blocked" \| "spawn" \| "timeout" \| "api"`, sanitized stderr) |
| `src/layers/AppLayer.ts` | merge `VcsCredentialsLive` into `BaseLive` (with `Layer.provide` of `ChildProcessSpawnerLive` + `ProcessEnvironmentLive` + `NodeFileSystemLive`) |
| `electron/shared/channels.ts` | detection results gain `outcome`, `source`, `errorKind?`, `validatedVia?: "direct" \| "cli"` and **drop the raw `token` field** (§8); `github:env-credentials` gains `params: { prefix?: string }`; `gitlab:enumerate-hosts` result per §4; `github:validate`/`gitlab:validate` gain `registerSession?: boolean`; **`clientId` (and `scopes`) become optional on `github:oauth-start`/`github:oauth-poll`** (main owns the default — `electron/main/ipc/github.ts:66`; the author-supplied custom-clientId prop path / `CustomOAuthWarning` flow keeps sending an explicit `clientId`); new `vcs:cli-status` channel `{ params: void; result: { gh: CliStatus; glab: CliStatus; git?: { sslBackend?: string } } }` where `CliStatus = { installed: boolean; version?: string; meetsFloor: boolean }`; new renderer-bound `vcs:session-changed` event (§4 item 9) |
| `electron/main/ipc/github.ts` / `gitlab.ts` | handlers call `VcsCredentials`; tri-state handling incl. cold trust-refresh-and-retry + §2.4 probe on `tls` (and *not* on `server-cert`/`network`); main-side session writes for ALL paths (incl. PAT via `registerSession`); `runPromiseExit` + `Cause.failureOption` pattern kept, `VcsCliError` added to the recovered set |
| `electron/main/ipc/runtime.ts` | token-custody model unchanged (provider-keyed session env stays the single source of truth); add a small main-only metadata map `{ provider → { host, source } }` for provenance/diagnostics and the stale-session warning |
| `electron/main/ipc/index.ts` | register `vcs:cli-status` handler; emit `vcs:session-changed` |
| `electron/main/remote.ts` + `src/remote-source.ts` | delete `getTokenForHost`/`tryCliToken` (lines 325-377); resolve via `VcsCredentials.tokenForHost` |
| `electron/main/logger.ts` | redaction pass (§8) |
| `web/.../GitAuth/hooks/useGitAuth.ts` | consume annotated hosts (`hosts.map(h => h.host)` for membership, §4 item 8) + `vcs:cli-status`; tri-state states (`foundButInvalid` vs new `foundButUnreachable`, which still ends in `detectionStatus: 'done'`); `"__other__"` sentinel interception before `changeHost`; drop the PAT-path `session:set-env` write (line ~198); drop the duplicated OAuth client-ID constant (line 20 — main owns it); stop holding raw tokens for env/cli/oauth paths; optional window-focus re-detect (§5) |
| `web/.../GitAuth/components/HostSelect.tsx` | `hasChoice` → `hosts.length >= 1`; provenance badges, key icon (+ tooltip/downgrade), "Other instance…" sentinel row; single-host no-credential hint |
| `web/.../GitAuth/components/AuthSuccess.tsx` / `AutoAuthInfo.tsx` | AuthSuccess: source line + transport line + divergence hint + stale-session warning + Windows schannel suggestion; initials-avatar fallback. AutoAuthInfo: FAQ copy updated ("Check again" instead of "reload the runbook") |
| `web/.../GitAuth/GitAuth.tsx`, `AuthTabs.tsx`, `PatForm.tsx` | TLS/server-cert/network card routing above the manual UI; **"Check again" control** next to the `vcs:cli-status` hint (§5 item 7); OAuth tab unconditionally present for GitHub, disabled-with-annotation under `unreachable` |

### Deleted

- `src/remote-source.ts:325-377` (second resolver).
- Renderer-side `session:set-env` token write for the PAT path.
- `detectTokenType` copy in `GitHubHttpClient.ts`; OAuth client-ID copy in `useGitAuth.ts`.
- The dead `glab auth token` invocation (`src/domain/gitlab/auth.ts:80`) — replaced by the per-host read.

---

## 7. Error UX

All remediation strings preserve the golang wording where it existed (tested contracts in beta-v0.9.0 `cmd/remote_open_test.go`); new TLS/network cases key off `errorKind`. The TLS, server-cert, and network cards are **strictly distinct** — and all are strictly distinct from any token warning.

| Scenario | Detection | UX |
|---|---|---|
| No credentials anywhere | all sources absent | Manual UI (OAuth/PAT for GitHub; PAT + instance URL for GitLab) — not an error. Hint line from `vcs:cli-status` + **Check again** control: "No existing credentials found. Sign in below, set GITHUB_TOKEN, or run 'gh auth login'." Remote-open path keeps golang strings: `authentication required for <host>/<owner>/<repo>: set GITHUB_TOKEN, or run 'gh auth login'` (GitLab: `set GITLAB_TOKEN, or run 'glab auth login'`) |
| CLI missing | spawn ENOENT / `vcs:cli-status` | silent fall-through during auto-detect (golang: missing binary is not an error); manual-UI hint: "Tip: install the GitHub CLI (gh)…" / for keyring-only glab configs **with glab absent**: "glab is configured to store tokens in the keyring; install glab or paste a token" |
| CLI installed, keyring unreadable | glab exit 1 + stderr `not found in keyring` (§2.2 contract c) | distinct copy: "glab stores this token in the OS keyring but could not read it — unlock your keyring or paste a token." Never the "install glab" phrasing |
| CLI installed, not logged in | gh exit 1 `no oauth token found`; glab exit 0 empty stdout; glab stderr `No token found` | silent fall-through; explicit attempt: `Not authenticated to GitHub CLI. Run 'gh auth login' to authenticate.` + **Check again** / `Not authenticated to <host> via glab. Run 'glab auth login --hostname <host>'.` + Reload. Never conflated with instance-down (glab stderr disambiguation, §2.2) |
| Token invalid (401/403) | validation `invalid` | warning chip per source, chain continues. Env-token chips: `"<VAR> is not valid for <host>"` (never "expired" — a 401 can't prove that). Mid-session git-op variant: `authentication failed for <repo> (token may be invalid or expired): verify GITHUB_TOKEN, or re-run 'gh auth login'` (GitLab variants). GitLab OAuth: one silent staleness-refresh retry (§2.2) before surfacing |
| glab OAuth stale, refresh failed | expiry check + `glab auth status` non-zero | expired-token warning with the exact `glab auth login --hostname <H>` remediation |
| **Custom CA not trusted by Node** (`errorKind: "tls"`) | `classifyTlsError` | handler runs `refreshSystemTrust()` (cold read, §3.1) once and retries; then tries the §2.4 CLI probe; if all fail, `TlsErrorCard`: *"Could not establish a secure connection to `<host>`: its certificate is not trusted by this system. If your organization uses a custom certificate authority, install it in the OS trust store (macOS: Keychain Access → System keychain, set **'Always Trust'** for SSL — hostname-scoped or per-app trust is not enough, and is the likely cause if gh/glab already work on this machine; Windows: Trusted Root Certification Authorities), then click **Retry**."* Layered remediation: `glab config set ca_cert /path/to/ca.pem --host <H>` (then Reload); Advanced: launch with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. **Retry** re-runs the cold-read trust refresh + detection without app restart; if the cold-read child itself fails, the card copy degrades to "…then restart Runbooks" (§3.1 fallback). **Never offer to skip verification** |
| **Server certificate problem** (`errorKind: "server-cert"`) | `classifyTlsError` (CERT_HAS_EXPIRED / ERR_TLS_CERT_ALTNAME_INVALID) | *"There is a problem with `<host>`'s server certificate (expired, or issued for a different hostname). Installing a CA cannot fix this — contact the instance administrator."* No trust refresh, no CLI probe, no CA-install copy. + Retry (transient clock/rotation cases) |
| CA in glab `ca_cert` but not OS store | harvested at enumeration (§3.1) | works transparently; no error |
| CLI probe succeeded, direct transport still TLS-blocked | §2.4 | auth **succeeds**; success card carries "validated via glab CLI" + persistent warning that MR/label API features need the CA installed (link to TlsErrorCard content); git operations unaffected |
| Instance unreachable (`errorKind: "network"`) | ENOTFOUND/ECONNREFUSED/ETIMEDOUT/EAI_AGAIN | *"Could not reach `<host>` (network error). Check the instance URL, VPN, or connectivity."* + Retry. Distinct from both auth and TLS failures; the chain stops **without consuming the token** (it may be valid); no CLI probe (it would fail identically); GitHub OAuth tab disabled with annotation |
| Windows git backend not schannel | proactive `vcs:cli-status` probe (§3.2) | **before** the first clone to a non-public host: auth success card / preflight hint "Git for Windows is using the OpenSSL backend, which ignores the Windows certificate store. Run: `git config --global http.sslBackend schannel`" + optional consented one-click apply. Reactive fallback on clone TLS stderr keeps the same copy — suggest (or one-click with consent), never silent |

---

## 8. Security

- **Custody model — normalized:** tokens live in the main-process session env (`GITHUB_TOKEN`+`GITHUB_USER`, `GITLAB_TOKEN`+`GITLAB_HOST`), provider-keyed (`getSessionTokenForProvider`). `github:validate`/`gitlab:validate` gain `registerSession: boolean` so the **main process writes session env for ALL credential sources** — the renderer-side `session:set-env` write on the PAT path (`useGitAuth.ts:198`) is retired. Single source of truth, single writer.
- **Metadata-only IPC (golang bar restored for env/cli/oauth):** detection results and OAuth-poll completion **drop the raw token field**; they carry user, scopes, tokenType, source, host, outcome. PAT entry necessarily transits renderer→main once over the context-isolated bridge and is never echoed back. The load-bearing `{block:'id'}` contract is preserved: when the referenced block is a GitAuth block, the consuming block's detection resolves against the session env in main (`useSessionToken` mode on the validate channels); when it is any other block, the renderer-held value flows as today. Scripts keep seeing `GITHUB_TOKEN` via session env, unchanged. Full secret-ref indirection for block outputs is deferred to a follow-up RFC (§11).
- **Env-token host binding (same rule as §2.2/§4, the single statement of record):** GitLab env tokens are auto-validated **only** against `envHost = normalize(GITLAB_HOST ?? GITLAB_URI ?? GL_HOST ?? "gitlab.com")` — never against glab-config, recent, session, or authored hosts. An authored runbook cannot cause the ambient env token to be transmitted to an arbitrary (or even a configured) origin. GitHub env tokens are validated only against github.com (the `--hostname` pin, §2.1). The `{env:{prefix}}` allowlist regex is enforced **in main** (new code).
- **Disk:** we never write tokens to disk. `vcs-auth.json` stores hostnames only. We never modify gh/glab config files and never invoke `gh auth login`/`glab auth login`/`glab config set`; glab rewriting *its own* config during refresh is glab's behavior — our per-host semaphore only prevents us racing ourselves against it. The only consented write we ever offer is the explicit Windows `git config --global http.sslBackend schannel` button (§3.2) — git config, never credentials.
- **Subprocess hygiene:** tokens reach gh/glab via **child env only, never argv** (argv is visible in `ps`). Per-host credential reads strip `GH_TOKEN`/`GITHUB_TOKEN` (gh) and `GITLAB_TOKEN`/`GITLAB_ACCESS_TOKEN`/`OAUTH_TOKEN` (glab) so the CLI is a distinct source and env tokens never leak to the wrong host. Every CLI child gets the telemetry/update/prompt kill switches (§2). The cold-read trust-refresh child (§3.1) receives no token env at all. git child env never gains the six forbidden TLS vars (test-pinned). Push restores the original remote URL in a finally (existing `GitCliClient.push`).
- **Redaction:** one `redactSecrets(s)` (`src/domain/vcs/redact.ts`) applied to all logged CLI stdout/stderr, every error message crossing IPC, and `makeLogger` output: the git URL scrubber `(?:x-access-token|oauth2):[^@]+@`, shape regexes `gh[pousr]_[A-Za-z0-9_]{20,}`, `github_pat_\w{20,}`, `glpat-[\w-]{15,}`, **plus exact-match removal of any token value currently in session env or read from `GITLAB_TOKEN`/`GITLAB_ACCESS_TOKEN`/`OAUTH_TOKEN`/`GITHUB_TOKEN`/`GH_TOKEN`** — the only safe way to catch GitLab's unprefixed 64-hex OAuth tokens.
- **TLS posture:** trust changes are strictly additive (union); `skip_tls_verify` ignored; no `setCertificateVerifyProc`, no `ignore-certificate-errors`, no `GIT_SSL_NO_VERIFY` — ever. CSP webRequest handler gains a URL filter (defense in depth).

---

## 9. Testing strategy (bun test, vitest, playwright, Bun scripts — one new vitest *config*, no new tooling)

**Runner reality (corrected from earlier drafts):** the repo today runs all backend tests under `bun test` (`package.json` `test`/`test:backend`) and vitest only for `web/` (the root `vitest.config.ts` is a re-export of web's jsdom config). There is **no** Node-runner backend suite yet — and Bun 1.3.x has `tls.setDefaultCACertificates === undefined`, so the TLS integration suite cannot run under the runner that would discover it by default. v2 therefore **adds** `vitest.integration.config.ts` (environment `node`, include `test/integration/**`), a `test:integration` script, CI wiring on the Node runner, and `--path-ignore-patterns='test/**'` on the `bun test` scripts so Bun never discovers the suite. This lands in Step 0 because Step 0's test needs it.

**Unit (`bun:test`, `Layer.succeed` fakes — the existing pattern from `src/domain/gitlab/auth.test.ts`, which imports from `bun:test`, not vitest):**
- `system-ca.test.ts`: union/dedupe/ordering with injected fake `CaSources`; idempotent re-run; **never re-reads "default" after install** (uses the snapshot — re-reading would compound extras); refresh consumes `systemPems()` output (fed by a fake cold reader); cold-read child failure falls back to the launch set; `classifyTlsError` mapping table with **undici-shaped fixtures** (`TypeError("fetch failed")` + `cause`, AggregateError nesting) covering all three classes + Chromium `ERR_CERT_*` future-proofing.
- `gitlab/auth.test.ts` additions: `readGlabHostMeta` (`is_oauth2`/expiry/`ca_cert`, incl. `!!null` tags); staleness decision under a fake clock; the three `glab config get token` exit contracts (token / empty-exit-0 / exit-1-keyring) → token / absent / keyring-blocked; `envTokenHost` binding (incl. `OAUTH_TOKEN` in glab's documented order, and **"env token is never sent to a host other than envHost"** pinned explicitly); env stripping and hygiene vars (`GLAB_NO_PROMPT=true`, `GLAB_CHECK_UPDATE=false`, and `NO_PROMPT` **stripped** — ambient included; it is deprecated in glab, and setting it makes glab print a warning on stdout ahead of every parsed payload) asserted on the fake `ProcessSpawner`'s received env; per-host semaphore serialization (two concurrent resolves → sequential spawns).
- `github/auth.test.ts` additions: `--hostname github.com` argv; `GH_PROMPT_DISABLED` set; precedence `GITHUB_TOKEN > GH_TOKEN` (golang parity table) + the both-set-differ hint; prefixed-env lookup + allowlist regex (valid/invalid prefixes); hosts.yml fallback (binary-absent only; keyring-empty hosts.yml message); `gh auth status` scope-regex tolerance matrix (port the golang test table).
- `VcsCredentialsLive`: chain precedence per §2 tables; first-success-wins; **tri-state semantics** — `invalid` continues, `unreachable` stops without consuming sources, `server-cert` skips refresh+probe; §2.4 probe gating (env-sourced OAuth-shaped GitLab tokens never probed; glab-sourced OAuth-shaped tokens probed via `glab auth status` without token injection; any probe failure class degrades to the card, never blocks); cache TTL + all invalidation triggers (failure, Reload, Check again, host pick); `tokenForHost` host classification (github.com / union member / heuristic / unknown→undefined-not-error); error-string snapshots for every §7 message; `/personal_access_tokens/self` 404 → no scope info, never an error.
- Regression: `gitSpawnEnv()` never contains `GIT_SSL_NO_VERIFY`, `GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`, `CURL_CA_BUNDLE`, `SSL_CERT_FILE`, `SSL_CERT_DIR`.
- `redactSecrets`: shape regexes + exact-match env scrub (incl. a 64-hex unprefixed token sourced from `OAUTH_TOKEN`).

**Integration (vitest, Node environment — the new `test:integration` project):**
- `test/fixtures/tls/` holds a committed fixture CA + `localhost`/`127.0.0.1` leaf (generated once by checked-in `scripts/gen-tls-fixtures.sh`, openssl, 100-year expiry). `test/integration/tls-custom-ca.test.ts`:
  1. Start a `node:https` server with the leaf, serving fake `/api/v4/user` + `/oauth/token/info`.
  2. Assert bare `fetch` fails and `classifyTlsError` says `"tls"` on the real undici rejection shape.
  3. Call `installSystemTrust([fixtureCaPem], realTlsIo)` — the fixture CA standing in for the OS store, since CI cannot mutate a real keychain — and assert `GitLabHttpClientLive.validateToken` succeeds against `https://localhost:<port>` (Bearer-first asserted via recorded headers).
  4. Restore the original CA list for isolation.
- **System-reader contract pins (replaces the earlier fake-only refresh test, which could not catch the cache):** (a) two successive in-process `tls.getCACertificates("system")` calls return the same frozen array — documents the per-process cache the §3.1 refresh design depends on, and fails loudly if Node ever changes the semantics; (b) the cold-read child (`process.execPath`, `ELECTRON_RUN_AS_NODE=1`, `-p …`) really spawns, exits 0, and returns parseable PEM JSON, and its output flows into `setDefaultCACertificates`.
- **Stub CLI shims** (`test/fixtures/vcs-cli/{gh,glab}`, shell scripts prepended to PATH, scripted via env vars): pin argv (`--hostname H`, `config get token --host H`), env injection (probe receives `GH_TOKEN`/`GITLAB_TOKEN` = candidate; reads receive stripped env incl. `OAUTH_TOKEN`), all three glab exit contracts incl. the keyring-stderr case, stderr routing (`glab auth status` all-stderr; `No token found` vs `API call failed`), `GLAB_CHECK_UPDATE` pinning, timeout kill.
- Probe-path integration: a stub `glab` whose `api user` proxies to the fixture-CA HTTPS server — full detect→tls-fail→probe→degraded-success flight without network.

**E2E (playwright `_electron.launch`, existing harness):**
- **In-Electron trust canary:** at launch, main logs the `installSystemTrust` counts; one e2e asserts `system > 0` on the macOS CI runner (its real system store has certs even though CI can't add custom ones). This converts the one-time "verified on Electron 41.1.1" claim into a continuously-checked invariant, catching Electron/BoringSSL and Node system-reader regressions before the field canary does.
- Launch with `GLAB_CONFIG_DIR=<fixture>` defining two hosts (`gitlab.com` + `localhost:<port>` with a `glpat-`-style token and `ca_cert: <fixture CA path>`) plus a local https GitLab stub: assert the dropdown shows both hosts with badges and key icons, pick the self-hosted one, assert zero-click success — hard reqs 1, 2, and 4 in one flight. Single-host case: gitlab.com-only config still renders the select with the "Other instance…" row.
- GitHub zero-click via stub gh on PATH → success card with "Detected from GitHub CLI (gh)". Invalid-token chip + fall-through. OAuth tab present with and without gh on PATH. **Check again:** stub gh initially logged-out → manual UI; flip the stub to logged-in → Check again → success without page reload.
- TLS card: fixture host with `ca_cert` removed and CA untrusted → assert the §7 TLS copy (and **not** "Invalid credentials detected"); then inject the CA via the dev/test-only `RUNBOOKS_TEST_EXTRA_CA` extraPems seam and assert **Retry** recovers without relaunch, **and** assert the cold-read child spawned (log line). *Scope honesty:* this e2e exercises the extraPems leg and the refresh mechanism's plumbing; the OS-store-mutated-mid-session leg is physically untestable in CI (no keychain mutation) and is covered by the manual QA gate below.
- "Other instance…" sentinel → instance-URL field revealed, `selectedHost` unchanged, no detection fired → PAT success → host appears as `recent` and is preselected (`lastSelectedGitLabHost`) after app restart.

**Manual QA release gate** (`docs/qa/custom-ca-release-gate.md` — the scenarios CI cannot truthfully automate):
- **macOS row:** genuine custom CA installed in the System keychain (**Always Trust**) + self-hosted GitLab behind it; exercise detect → validate → clone → push → MR end to end; repeat once with the CA installed **mid-session** to verify the cold-read Retry recovers without relaunch.
- **Windows row:** corp CA in the machine store + **default Git-for-Windows install (OpenSSL backend)**; verify API/OAuth legs work with no action, the proactive schannel suggestion appears before the first clone, and clone/push succeed after the consented one-click `http.sslBackend schannel`.

---

## 10. Migration plan (ordered; each step ships green)

**Step 0 — customer hotfix (single cherry-pickable PR, self-contained).** Add the `tls.setDefaultCACertificates` union **with the bundled-defaults snapshot** to `electron/main/index.ts` immediately after `populateShellEnv()` (line 31), before `registerAllIpcHandlers()`/`initAutoUpdater()`/any TLS, with the caveat comments (per-thread; first-connection cache; system-reader process-lifetime cache). Deliverables also include everything its test needs, none of which may depend on later steps: `test/fixtures/tls/*` + `scripts/gen-tls-fixtures.sh`; the new `vitest.integration.config.ts` + `test:integration` script + CI wiring + `bun test` path-ignore for `test/**`; a self-contained integration test asserting bare `fetch` fails against the fixture server and that the **raw** `tls.setDefaultCACertificates([...snapshot, fixtureCa])` union recovers it (no `installSystemTrust`/`classifyTlsError` imports — those are Step 1). *The customer incident — API validation and OAuth device flow, CA installed before launch — is fixed at this point.*

**Step 1 — TLS foundation.** Add `src/domain/tls/system-ca.ts` (`installSystemTrust`, cold-read refresh child, `classifyTlsError` with cause unwrapping) + unit tests; refactor Step 0's inline call and integration test onto it; export `refreshSystemTrust()`; launch-time count logging; add `kind` to both API error classes and the two HttpClient catch paths; Bearer-first in `GitLabHttpClient.ts`; dedupe `detectTokenType`.

**Step 2 — tri-state + TLS error UX.** `outcome`/`errorKind` through `electron/shared/channels.ts` and the `github.ts`/`gitlab.ts` handlers (cold refresh-and-retry on `tls`; no refresh/probe on `server-cert`); `TlsErrorCard.tsx` with Retry + server-cert + network variants; `useGitAuth.ts` `foundButUnreachable` state (ends in `detectionStatus: 'done'`, manual UI stays rendered, OAuth tab disabled under `unreachable`); CSP `onHeadersReceived` URL filter in `electron/main/window.ts`; initials-avatar fallback. *The misdiagnosis class is dead at this point.*

**Step 3 — credential-source upgrades + diagnostics.** Extend `src/domain/git/cli-token.ts` (env overrides); `src/domain/gitlab/auth.ts` (`detectCliCredentialsForHost` with the three exit contracts, `readGlabHostMeta`, `refreshOAuthViaGlab`, semaphore, `envTokenHost` binding rule, `OAUTH_TOKEN`); `src/domain/github/auth.ts` (`--hostname` pin, hygiene env, prefixed-env implementation, hosts.yml binary-absent fallback); `ca_cert` harvest wired into enumeration → `installSystemTrust`; `vcs:cli-status` channel + handler (incl. the Windows git sslBackend probe) + hint copy + the GitHub **Check again** control.

**Step 4 — VcsCredentials unification + CLI probe.** Add `src/services/VcsCredentials.ts`, `src/layers/VcsCredentialsLive.ts`; compose in `AppLayer.ts`; rewire `github.ts`/`gitlab.ts` handlers; implement the §2.4 validation probe (both shapes) + degraded-host handling; **delete `src/remote-source.ts:325-377`** and point `electron/main/remote.ts` at `tokenForHost` (session env first); port the golang remediation-string tests.

**Step 5 — host merge + persistence + dropdown polish.** Add `electron/main/recent-hosts.ts` (recents most-recent-first + `lastSelectedGitLabHost`); extend `gitlab:enumerate-hosts`; `HostSelect.tsx` `hasChoice >= 1`, badges, key icon + tooltip/downgrade, "Other instance…" sentinel, single-host hint; `AuthSuccess.tsx`/`AutoAuthInfo.tsx` source/transport lines + FAQ copy + stale-session warning via `vcs:session-changed`.

**Step 6 — custody + hygiene normalization.** `registerSession` on the validate channels; main-side session writes for PAT; remove the renderer `session:set-env` write; metadata-only detection results + `useSessionToken` block-chaining mode; `src/domain/vcs/redact.ts` wired into `makeLogger` and IPC error paths; drop the renderer OAuth client-ID constant **and make `clientId`/`scopes` optional on `github:oauth-start`/`oauth-poll`** (the custom-clientId author prop keeps sending it explicitly).

**Step 7 — tests, e2e, docs.** Playwright specs of §9 (incl. the in-Electron trust canary and Check-again flight); stub shims; `docs/qa/custom-ca-release-gate.md` (macOS + Windows rows); support doc for `NODE_EXTRA_CA_CERTS`, the Keychain Always-Trust procedure, and the Windows schannel switch.

Steps 0–2 are a shippable hotfix release for the affected customer; 3–7 complete v2.

**File summary — add:** `src/domain/tls/system-ca.ts`(+test), `src/services/VcsCredentials.ts`, `src/layers/VcsCredentialsLive.ts`, `src/domain/vcs/redact.ts`, `electron/main/recent-hosts.ts`, `web/.../GitAuth/components/TlsErrorCard.tsx`, `vitest.integration.config.ts`, `test/integration/tls-custom-ca.test.ts`, `test/fixtures/tls/*`, `test/fixtures/vcs-cli/{gh,glab}`, `scripts/gen-tls-fixtures.sh`, `docs/qa/custom-ca-release-gate.md`. **Modify:** `package.json` (+CI workflow), `electron/main/{index,window,remote}.ts`, `electron/shared/channels.ts`, `electron/main/ipc/{index,github,gitlab,runtime}.ts`, `electron/main/logger.ts`, `src/layers/{AppLayer,GitHubHttpClient,GitLabHttpClient}.ts`, `src/errors/index.ts`, `src/domain/github/auth.ts`, `src/domain/gitlab/auth.ts`, `src/domain/git/cli-token.ts`, `src/remote-source.ts`, `web/.../GitAuth/{GitAuth.tsx,hooks/useGitAuth.ts,components/{HostSelect,AuthSuccess,AutoAuthInfo,AuthTabs,PatForm}.tsx}`. **Delete:** `src/remote-source.ts:325-377`, renderer PAT `session:set-env` write, `detectTokenType` and OAuth client-ID duplicates, the dead `glab auth token` invocation.

---

## 11. Risks & open questions

- **Young Node API, cached system reader.** `setDefaultCACertificates` (Node 24.5+) and its `"system"` reader are the load-bearing mechanism. The reader's process-lifetime cache (the reason refresh must be a cold out-of-process read, §3.1) is **pinned by an integration test** so a Node semantics change is caught in CI, not the field. CI cannot mutate a real OS keychain, so the literal system-store read is covered by: the e2e launch canary (`system > 0` on the macOS runner — continuously checked, catches Electron/BoringSSL regressions), the manual QA gate, and the **field canary** (direct validation TLS-fails while the §2.4 probe succeeds → structured `transport degraded` log). With the cold-read refresh, that canary now indicates a genuine reader gap, not a fixable-by-restart cache artifact. A Node regression degrades to probe-validated auth + remediation card, never to "Invalid credentials". Track upstream: a cache-invalidation API for `getCACertificates("system")` is worth a Node issue.
- **macOS trust-store reader gaps.** Node's `"system"` read loads only unrestricted Always-Trust SSL certs from the Default/System keychains; hostname-scoped or per-app trust is skipped — such machines are "the CA is in the OS trust store" from the customer's viewpoint, and requirement 4 is met there only via degraded auth. Mitigations, in order: glab `ca_cert` harvest; the §2.4 probe — which now also covers glab-sourced OAuth-shaped tokens via `glab auth status` (no token injection), shrinking the former dead-end sliver to env-sourced OAuth tokens only; the TLS card's explicit "Always Trust / hostname-scoped" wording; `NODE_EXTRA_CA_CERTS`. Residual: accepted, documented.
- **Windows git backend.** Requirement 4's git leg on Windows requires the user-consented schannel switch (§3.2) — stated in the §1 scorecard, surfaced proactively, QA-gated. Not silently fixed by design choice: we do not write git config without an explicit button press.
- **Corporate proxies are explicitly unfixed.** undici ignores OS proxy/PAC/NTLM. Out of incident scope. The escape route is pre-designed but not built: a fetch-shaped `VcsHttp` service tag in front of the two HttpClient layers, with an Electron `net.fetch` implementation (dynamic `import("electron")` so layers stay Bun/vitest-safe) — the CSP webRequest URL filter shipped in Step 2 is the prerequisite hygiene. Build only when a proxy/PAC customer materializes.
- **glab internals coupling.** `is_oauth2`/`oauth2_expiry_date`/`ca_cert` field names, the refresh-via-`glab auth status` side effect, and the three `config get token` exit contracts are observed behavior (verified against glab 1.101.0 and at source), not stable APIs. Known hazard: glab issue #8168 — keyring-stored tokens misbehave in v1.84.0 through at least v1.85.2; affected versions degrade through the keyring-blocked contract to the paste-a-token path. Version floors: gh ≥ 2.26.0 (keyring storage introduction); **glab ≥ 1.75.0 is a support-policy floor, not a verified behavior cliff** — behavior is verified at 1.101.0, and stub-shim tests pin that every pre-floor/unknown failure mode degrades to absent + manual paste, never breakage. Newly observed at 1.101.0: setting the deprecated `NO_PROMPT` env var makes glab print a warning **on stdout** ahead of every payload — handled by stripping the var, ambient included (§2.2, pinned by the stub shim).
- **Critic-claim rejection (recorded per process):** the claim that `glab config get token`'s keyring read is unverifiable is rejected — glab's config layer (schema `Keyring: true`, `Config.GetWithSource` keyring path, legacy `glab:<host>` key) confirms the read at source; the genuinely open residuals (exit-1 keyring contract, #8168 window) are handled in §2.2 and above.
- **Process-global, per-thread trust mutation.** The CA union affects every Node TLS client in main (intended; additive — see the corrected §3.0 inventory) and must be repeated in any future `worker_threads`/`utilityProcess` (none today; lint-comment in `system-ca.ts`).
- **glab config races with the user's terminal.** Our semaphore serializes *our* spawns; a user-run glab can still race glab's lockless config rewrite. Window is tiny; worst case is a stale token → one failed call → staleness retry. Accepted.
- **Tokens still reach the renderer in two places:** PAT entry (one inbound transit, unavoidable) and non-GitAuth block outputs consumed by `{block:'id'}`. The detection/oauth paths are metadata-only as of Step 6; full block-outputs secret-ref indirection (outputs store `$SESSION:GITHUB_TOKEN`, resolved main-side) changes runbook-author-visible semantics and is deferred to a follow-up RFC (must include a compatibility check for runbooks that interpolate token outputs in templates).
- **gh multi-account (≥2.40):** `gh auth token --hostname` returns the active account's token; we don't expose `--user` selection. A second authenticated account is a real credential we cannot select — excluded in the §1 scorecard. Document "use gh auth switch" + the Check-again control; revisit on demand.
- **Env precedence divergences, made visible:** we keep `GITHUB_TOKEN > GH_TOKEN` (golang parity, tested) against gh's own order, but the both-set-and-different case now renders an explicit hint (§2.1) so the shadowing is visible exactly when it bites. GitLab `defaultHost` now follows glab (`GITLAB_HOST` over config default, §4) — no divergence remains there. Open question: flip the GitHub order in a future major?
- **GHES** remains out of scope and is excluded explicitly in the §1 scorecard (gh-on-GHES logins, `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` never consulted); the `--hostname`-everywhere CLI surface, the `host` param on `github:validate`, and enterprise-token env handling are the natural seam. Cheapest future partial: accept `GH_ENTERPRISE_TOKEN` once a `github-enterprise` host param exists.
- **Two GitLab instances in one runbook:** single `GITLAB_TOKEN`/`GITLAB_HOST` session pair; the degraded behavior is now specified (stale-session warning via `vcs:session-changed` + the runtime.ts metadata map, §4 item 9); the real fix (host-keyed session map or per-block env suffix) is deferred.
- **Open question:** should trust refresh also poll for OS-store changes instead of refresh-on-failure/Retry? Deferred — the cold-read Retry covers the realistic "IT just pushed the CA" flow without a polling subprocess.
- **Open question:** surface `vcs:cli-status` + degraded-transport state in a support diagnostics panel? Cheap once the channel exists; recommended as a fast follow.

---

## 12. Implementation deviations (recorded post-implementation, branch vcs-auth-v2)

Reality-driven deviations from the letter of this doc; everything else landed as specified. Each is also noted in the relevant commit message.

- **§6 interface, extended:** `VcsCredentials` additionally exposes per-source detection legs (`detectGitHubEnv/Cli`, `detectGitLabEnv/Cli`) and `validateDirect` — the renderer's per-source `detectCredentials` contract is preserved unchanged (§2), so the per-source channels need per-leg service methods; `resolveGitHub/resolveGitLab` compose them. `markTransportDegraded`/`isTransportDegraded`/`clearTransportDegraded` are explicit interface members.
- **§2.3 session-env precedence:** composed in the caller (`electron/main/remote.ts`) rather than inside `tokenForHost` — the session singleton is Electron-side and the layer must stay Bun-test-safe. Behavior identical.
- **Tri-state orchestration location:** the cold trust-refresh-and-retry + §2.4 probe ladder lives in `electron/main/ipc/vcs-tristate.ts` (shared by both handlers), because the cold-read child is wired in `electron/main/index.ts` (per §6's handler row).
- **New channels beyond the §6 list:** `vcs:invalidate-cache` (the §5-item-7 "Check again wired to invalidateCache" surface, also used by Reload and host picks), `gitlab:host-picked` (the §4 "lastSelected written on every explicit dropdown pick" surface), `vcs:apply-git-schannel` (the §3.2 consented one-click). All allowlisted in the preload bridge.
- **New file:** `src/domain/vcs/cli-status.ts` — the version/sslBackend probes, shared by the Step-3 handler and `VcsCredentialsLive` (which owns the probe *cache* per §6).
- **§2.1 #3b corrected:** gh resolves exactly one config dir (see §2.1 — caught by the e2e when a real `~/.config/gh` leaked past a set `GH_CONFIG_DIR`).
- **§9 trust canary:** asserted via `app.evaluate` in the main process (the launch log line outruns Playwright's stdout listeners) and asserts *parity with the host's own Node reader* — a clean macOS keychain legitimately reads `system=0` (verified: plain `node` reads 0 on such hosts), so `system > 0` is enforced exactly when the host has OS-store certs (true on CI runners).
- **§9 GitHub Check-again flight:** asserts re-detection-without-reload via the found-but-invalid chip; a full zero-click *success* leg would require api.github.com to accept a stub token (validation is a direct main-process fetch Playwright cannot intercept). The success path is covered by the GitLab flights + unit tests.
- **§9 restart flight vs §4:** after restart, the manually-added host appears as a `recent` union entry but is **not preselected** — it has no offline credential and the §4 `hasCredential` gate ("a credential-less stale pick must not steal auto-detect") deliberately wins over the §9 sketch.
- **§4 stale-session events for the PAT path** emit from Step 6 onward (main-side `registerSession` writes); detection/oauth paths emit from Step 5.
- **playwright config:** `workers: 1` pinned in `electron/e2e/playwright.config.ts` — the app's single-instance lock makes parallel Electron launches quit immediately (CI already passed `--workers=1` via the justfile; the package.json script did not).
- **§2.2 `NO_PROMPT` is stripped, never set:** an early draft set `NO_PROMPT=true` alongside `GLAB_NO_PROMPT=true` for older glab coverage. Against real glab 1.101.0 that makes every credential read fail: the var is deprecated, and glab prints a warning **on stdout** when it is set, so the contract-(a) first-line read returns the warning text as the "token" and the §2.4 `api user` JSON parse throws. No one uses runbooks yet, so the old-glab coverage is dropped outright rather than deprecation-handled: `NO_PROMPT` is stripped (ambient included) and the stub shim FAILS any spawn where it survives.
- **§2.0/§3.1 status-0 backstop — the tri-state split alone did NOT close the misdiagnosis.** `classifyTlsError` returns `undefined` for any OpenSSL code outside its enumerated sets, and `toDetection` originally treated a kind-less validation failure as `outcome:"invalid"`. So an *unenumerated* cert-verification code (e.g. `CERT_REVOKED`, `CERT_NOT_YET_VALID`, `UNABLE_TO_GET_ISSUER_CERT`, `CERT_UNTRUSTED`) still surfaced as "Invalid credentials detected" — the exact bug §2.0 exists to kill. Fixed in two places: (1) the code sets in `src/domain/tls/system-ca.ts` gained those siblings (`UNABLE_TO_GET_ISSUER_CERT`/`CERT_UNTRUSTED` → `tls`; `CERT_NOT_YET_VALID`/`CERT_REVOKED` → `server-cert`); (2) the load-bearing guarantee is now a `status === 0` backstop in `toDetection` (`src/layers/VcsCredentialsLive.ts`) — a transport throw carries no HTTP status (status 0) whereas a real 401/403 always does, so any status-0 failure is routed to `unreachable` (defaulting `errorKind:"tls"`, which still runs the §3.1 refresh + §2.4 probe ladder) and can never become `invalid`. Pinned by `system-ca.test.ts` (an unenumerated code stays `undefined` at the classifier) and `VcsCredentialsLive.test.ts` (status-0/no-kind → unreachable+tls; status-401/no-kind → invalid).
- **§7 TLS card copy simplified.** The `tls` card's prescriptive "install the CA in the OS trust store … then click Retry" body (plus the macOS Keychain / Windows / `glab config set ca_cert` / `NODE_EXTRA_CA_CERTS` remediation block) over-claimed a local-CA fix and could dead-end when the real fault is a wrong/incomplete *server-side* chain (or when the same card now also fronts the unclassified-code path). Replaced with a neutral diagnostic — heading **"Invalid certificate chain"**, body *"Check the local CA root and `<host>`'s server certificate."* — that names both possible causes without prescribing the wrong fix. The **Retry** button (cold-read trust refresh, no restart) is kept; the `coldReadOk === false` degraded note is kept; the `server-cert`/`network` cards are unchanged. The now-unused `provider` prop was dropped from `TlsErrorCard`.
