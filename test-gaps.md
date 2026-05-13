# Test Coverage Gap Plan — Go → Electron Rewrite (PR #120)

This plan covers test-coverage gaps left by the Go → TypeScript/Electron rewrite. Each section names the production file(s), the new test file to create or extend, the specific cases to add, and acceptance criteria.

Gaps are ordered roughly by **risk × ease-of-regression**. Telemetry is intentionally excluded.

Reference test patterns to mirror:
- Domain logic with Effect: `src/domain/git/operations.test.ts`, `src/domain/exec/script.test.ts`
- Path-validation style: `src/path-validation.test.ts`
- Behavioural shell wrapper tests: there is no existing pattern — see the section below for how to introduce one.

Test runner: `bun test` for `src/`, `electron/`, `cli/`; `vitest` for `web/`.

---

## 1. CLI test framework (`cli/test/*.ts`) — HIGH

**Status:** ~1000 lines of Go coverage deleted, zero TS tests added. This is the runbook test runner that downstream users invoke via `runbooks test`. Regressions here break user workflows silently.

**Production files (currently untested):**
- `cli/test/config.ts` — parses `runbook_test.yml` and assertion specs
- `cli/test/executor.ts` — orchestrates per-block execution against testdata fixtures
- `cli/test/assertions.ts` — assertion matchers (exit code, stdout, file contents, outputs)
- `cli/test/fuzz.ts` — fuzz-input generation
- `cli/test/validation.ts` — runbook-test schema validation
- `cli/test/reporter.ts` — result formatting

**Tests to add (priority order):**

`cli/test/config.test.ts`
- `parseConfig` rejects unknown top-level keys
- `parseConfig` rejects missing required fields (per block type)
- AWS env-credential block: reads `AWS_ACCESS_KEY_ID` etc. from process env when `auth_mode: env`
- Auth-dependency parsing: a block declaring `auth: aws-block-id` is correctly linked to that block's outputs
- GitClone-from-config: a config-defined GitClone block produces the right `cloneURL` / `localPath`
- Worktree target resolution: assertions targeting `${worktree}/path` resolve against the configured clone path
- MDX prop extraction: a `<Template id="x" outputPath="...">` block produces the expected runner inputs

`cli/test/assertions.test.ts`
- `exit_code: 0` matcher passes on success, fails on non-zero
- `stdout_contains` / `stdout_regex` matchers
- `file_exists` / `file_contains` against runner outputs dir
- `outputs.<block_id>.key == value` (block-output assertion)
- Negative cases: each matcher produces a useful error message on mismatch

`cli/test/executor.test.ts`
- Runs a single-block fixture (use `testdata/sample-runbooks/my-first-runbook/`) end-to-end and verifies pass status
- Runs a fixture with intentional failure (e.g. exit code 1) and verifies fail status
- Templates with worktree targets execute in the right `cwd`
- Cleanup: temp dirs removed after execution

`cli/test/fuzz.test.ts`
- `generateFuzzInputs` produces N variants for a spec
- Boundary values (empty string, max-length, type-mismatches) are generated when declared

`cli/test/validation.test.ts`
- Schema validation: each documented field passes; misspelled/extra fields fail with a useful error

**Acceptance:** Each `cli/test/*.ts` source file has a sibling `*.test.ts` with ≥3 happy-path tests and ≥2 failure-path tests. Coverage of `cli/test/` ≥70%.

**Effort:** ~2–3 days. Use the deleted `api/testing/config_test.go` and `api/testing/executor_test.go` (recoverable via `git show c763919:api/testing/...`) as the case checklist.

---

## 2. `runbooks test init` (`cli/commands/test.ts`) — HIGH

**Status:** `cmd/test_init_test.go` covered block-parsing, regex variants, ordering, dedupe — none migrated.

**Production file:** `cli/commands/test.ts` (~347 lines, no tests).

**Tests to add — `cli/commands/test.test.ts`:**
- `parseRunbookBlocks` preserves document order across mixed block types
- Nested `<Inputs>` inside another block are deduplicated (a single root-level entry)
- Block-tag regex variants:
  - Self-closing: `<Check id="x" />`
  - Container: `<Command id="x">…</Command>`
  - Multi-line container with nested children
- `generateTestConfig` emits blocks in document order, not alphabetical
- Real-fixture test: pointing `parseRunbookBlocks` at `testdata/sample-runbooks/demo2/runbook.mdx` produces the expected `runbook_test.yml` (compare against the existing one in the fixture)

**Acceptance:** All four regex variants from the Go test are covered; demo2 round-trip test passes.

**Effort:** ~half a day.

---

## 3. Git operations (`src/domain/git/operations.ts`) — HIGH (security-adjacent)

**Status:** Token-injection logic and validation helpers shipped without unit tests. Auth bugs here can leak tokens into logs or fail silently.

**Production file:** `src/domain/git/operations.ts`. Extend `src/domain/git/operations.test.ts`.

**Tests to add:**
- `injectTokenIntoUrl` (currently defined inline in `electron/main/ipc/git.ts` and `src/layers/GitCliClient.ts` — extract to a shared helper first):
  - HTTPS GitHub URL → `https://x-access-token:TOKEN@github.com/owner/repo.git`
  - HTTPS GitLab URL → `https://oauth2:TOKEN@gitlab.com/owner/repo.git` (or document why we don't differentiate)
  - SSH URL (`git@github.com:owner/repo.git`) → unchanged (token has no place to live)
  - Empty/malformed URL → unchanged, no throw
  - URL already containing userinfo → overwritten, not appended (regression case: don't end up with `user1:pass1@user2:pass2@host`)
  - **Security check:** the test asserts the token is never present in any thrown error or returned value other than the URL itself (mock console.error and check)
- `isValidGitHubOwner`: alphanumeric + dash, no leading dash, ≤39 chars
- `isValidGitHubRepoName`: alphanumeric + dash + underscore + dot, no leading dot/dash, length cap
- `getBaseBranch`:
  - Reads `refs/remotes/origin/HEAD` via `git symbolic-ref` and returns the branch name
  - Falls back to `main` when the symbolic-ref call fails (existing layer covers this — assert the fallback explicitly)
- `parseOwnerRepoFromURL` already has implicit coverage; add explicit cases for trailing slashes and `.git` stripping in both SSH and HTTPS

**Refactor prerequisite:** Move `injectTokenIntoUrl` out of `electron/main/ipc/git.ts` and `src/layers/GitCliClient.ts` (currently duplicated) into `src/domain/git/operations.ts` or a new `src/domain/git/url.ts`. Both callers should import it.

**Acceptance:** `injectTokenIntoUrl` has explicit tests for every protocol variant; one test asserts no token-leakage path.

**Effort:** ~half a day (mostly the refactor + cases).

---

## 4. File manifest (`src/domain/files/manifest.ts`) — HIGH (security)

**Status:** `applyDiff` and `cleanupEmptyParentDirs` are exported, used to delete files, and untested. The Go suite had explicit traversal/symlink attack tests here.

**Production file:** `src/domain/files/manifest.ts`. Extend `src/domain/files/manifest.test.ts`.

**Tests to add:**
- `applyDiff` happy path: creates new files, modifies changed files, removes orphaned files
- `applyDiff` rejects unsafe paths in every field:
  - `Created` containing `../` segments
  - `Created` containing absolute paths
  - `Modified` with same → fails
  - `Orphaned` containing `../` or absolute paths → fails
- `applyDiff` symlink-attack matrix: if `Orphaned` points to a symlink whose target escapes the manifest dir, the target must not be removed
- `applyDiff` from string content (not from a directory walk): exercises the `applyDiffFromContent` variant
- `cleanupEmptyParentDirs` removes parents only up to the boundary directory; never above
- `cleanupEmptyParentDirs` stops at the first non-empty parent
- Render-with-manifest behaviour: a second render with identical content emits zero filesystem writes (mock the FileSystem service, assert no `writeFile` calls)

**Test scaffolding:** Use a temp directory via `fs.mkdtempSync` per test; `afterEach` removes it. Build a fixture manifest in code, not on disk.

**Acceptance:** All four rejection scenarios from the deleted Go test (`TestApplyDiff_RejectsUnsafePaths`) and the symlink scenario (`TestApplyDiff_NeverDeletesOutsideOutputDir`) have TS equivalents.

**Effort:** ~1 day.

---

## 5. Bash wrapper behaviour (`src/domain/exec/script.ts`) — MEDIUM

**Status:** TS tests only check that the wrapped output string contains expected substrings. Go tests actually executed the wrapped script against a real `/bin/bash` to verify trap chaining and logging output. The wrapper is the runtime contract for every executed block — a regression here silently corrupts captured env or user `trap EXIT` cleanup.

**Production file:** `src/domain/exec/script.ts`. Extend `src/domain/exec/script.test.ts`.

**Tests to add:**
- Execute a wrapped script that defines its own `trap "echo USER_CLEANUP" EXIT`. Verify both the user trap output AND the env-capture file are produced.
- Execute a wrapped script that overrides trap multiple times — only the last user trap runs; env capture always runs after it.
- Execute a wrapped script that calls `trap - EXIT` (reset) — env capture still runs.
- Execute a wrapped script that calls `log_info "x"` / `log_warn "x"` / `log_error "x"` — output contains `[INFO]`/`[WARN]`/`[ERROR]` prefixes and an ISO-8601 timestamp.
- Execute a wrapped script that calls `log_debug "x"` with `DEBUG` env unset — no output.
- Execute a wrapped script that calls `log_debug "x"` with `DEBUG=true` — output appears with `[DEBUG]` prefix.
- Multi-line env values (e.g. `export FOO=$'a\nb'`) survive capture-and-parse round-trip via the NUL-delimited `env -0` path.
- `isValidEnvVarName`: export it (or test via a re-export in tests) and cover edge cases (leading digit, empty string, dot, unicode).

**Test scaffolding:** New helper `runWrapped(script: string, env?: Record<string,string>): Promise<{ stdout, stderr, capturedEnv, capturedPwd }>`. Spawns `/bin/bash` with the wrapped script, writes to temp files, reads them back. Skip the whole describe block if `process.platform === "win32"`.

**Acceptance:** The trap-chaining behaviour and log-level filtering are verified by spawning bash, not by string-matching the wrapper template.

**Effort:** ~1 day. Bun test supports async; spawning bash is straightforward.

---

## 6. Workspace tree truncation (`src/domain/workspace/workspace.ts`, `file-tree.ts`) — MEDIUM

**Status:** Happy-path tree-building is tested; truncation and binary-detection limits are not. These limits exist to prevent runaway memory usage when a user loads a runbook in a large repo.

**Production files:** `src/domain/workspace/workspace.ts`, `src/domain/workspace/file-tree.ts`.

**Tests to add — `src/domain/workspace/file-tree.test.ts` (new) and extend `workspace.test.ts`:**
- `buildFileTree` respects `maxFiles`: with a fixture of N+10 files and `maxFiles=N`, the result has exactly N entries plus a `truncated: true` flag
- Per-file size cap: a file larger than the configured byte limit is included in the listing but marked with `tooLarge: true` (or whatever the existing shape uses)
- "Heavy dir" detection: a dir with thousands of small files emits a `truncated` flag for that subtree
- VCS dirs are always skipped: `.git`, `.hg`, `.svn` never appear regardless of `maxFiles` setting
- `readWorkspaceFile` rejects files above the binary-detection threshold
- `readWorkspaceFile` correctly classifies binary content (e.g. a file containing NUL bytes) and returns `binary: true` without the content
- `parseGitStatusCode` / `parseStatusLines`: cover modified, untracked, deleted, renamed, copied, conflict states

**Test scaffolding:** Build fixture trees in `fs.mkdtempSync` per test. For large-file tests, write fixed-size buffers (e.g. `Buffer.alloc(maxBytes + 1)`).

**Acceptance:** Each truncation/limit knob has at least one positive and one negative test.

**Effort:** ~1 day.

---

## 7. Remote source resolution (`src/remote-source.ts`) — MEDIUM

**Status:** `resolveRef` (longest-ref matching) and `getTokenForHost` (env-var precedence) ship without tests. They're the entry point for `runbooks open <remote-url>`.

**Production file:** `src/remote-source.ts`. Extend `src/remote-source.test.ts`.

**Tests to add:**
- `resolveRef` — given a mocked `git ls-remote` output containing `main`, `release/v1`, `release/v1.2`, and a `rawRefAndPath = "release/v1.2/foo/bar.md"`, returns `{ ref: "release/v1.2", path: "foo/bar.md" }` (longest match wins).
- `resolveRef` falls back to "first segment is ref" when no candidate matches.
- `resolveRef` surfaces a `RemoteSourceError` when `git ls-remote` exits non-zero (mock ProcessSpawner to fail).
- `getTokenForHost("github.com")`:
  - `GITHUB_TOKEN=A` → returns `"A"`
  - `GH_TOKEN=B` only → returns `"B"`
  - Both set → `GITHUB_TOKEN` wins
  - Neither set, mocked `gh auth token` returns `C` → returns `"C"`
  - Neither set, `gh` not on PATH → returns `undefined`
- `getTokenForHost("gitlab.com")`: `GITLAB_TOKEN` then `glab auth token` then undefined.
- `getTokenForHost("example.com")`: returns `undefined` (no special-case).

**Test scaffolding:** Use the existing `TestLayer` / `TestSpawner` from `src/test-utils/` to inject mocked `ProcessSpawner` and `Environment`.

**Acceptance:** All four token-precedence rules and both fallback paths have explicit tests.

**Effort:** ~half a day.

---

## 8. GitHub auth helpers (`src/domain/github/auth.ts`) — LOW–MEDIUM

**Status:** `parseGitHubCliScopes`, `isAllowedGitHubEnvVar`/`isValidEnvVarPrefix`, `isDefaultGitHubOAuthClientID`, and the `cli-credentials` response shape (`Found`, `HasRepoScope`) were Go-tested; no TS equivalent. Check first whether each is still present in TS — if pruned during the port, delete the gap.

**Production file:** `src/domain/github/auth.ts`. Extend `src/domain/github/auth.test.ts`.

**Tests to add (only for helpers that still exist):**
- `parseGitHubCliScopes`: parses `X-OAuth-Scopes: repo, read:org` style header into a string array; handles empty header, missing header, comma-and-space variants.
- `isAllowedGitHubEnvVar`: allowlist exactly matches `GITHUB_TOKEN`, `GH_TOKEN`, etc.; rejects `GITHUB_TOKEN_EVIL`, `gITHUB_TOKEN`, etc.
- CLI-credentials detect: when `gh auth status` reports a valid token with `repo` scope, returns `found: true, hasRepoScope: true`; without `repo` scope, `hasRepoScope: false`.

**Acceptance:** Each allowlist + scope-parsing helper has a positive and a negative test.

**Effort:** ~half a day (or skip entirely if the helpers were dropped during the port).

---

## 9. AWS env-var allowlist (`src/domain/aws/auth.ts`) — LOW–MEDIUM

**Status:** `isAllowedAwsEnvVar` and `isValidAwsEnvVarPrefix` (which AWS env vars from the user's shell are passed through to scripts) had Go coverage. Without tests, a typo here could either leak credentials into wrong-scoped env or break user workflows.

**Production file:** `src/domain/aws/auth.ts` (or wherever the allowlist now lives — confirm location).

**Tests to add — `src/domain/aws/auth.test.ts` (extend):**
- Allowlist hits: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_DEFAULT_REGION`, `AWS_REGION`, `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`
- Prefix match: `AWS_ENDPOINT_URL`, `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL_STS` allowed if `AWS_ENDPOINT_URL` is the prefix
- Rejections: `aws_access_key_id` (case-sensitive), `AWS`, `AWSX_FOO`, empty string

**Acceptance:** Each documented env var has an explicit test entry; one case-sensitivity test exists.

**Effort:** ~2 hours.

---

## 10. Electron remote-open UX (`electron/main/remote.ts`) — LOW–MEDIUM

**Status:** `electron/main/remote.test.ts` only covers `isRemoteURL`. The user-facing error-classification logic from `cmd/remote_open_test.go` (which produces "your token may be expired" / "GitLab uses GITLAB_TOKEN" hints) is untested in the rewrite.

**Production file:** `electron/main/remote.ts`. Extend `electron/main/remote.test.ts`.

**Tests to add:**
- `isAuthError`: returns true for git stderr containing `authentication failed`, `403`, `401`, `could not read username`; false for unrelated errors.
- `authHintForHost("github.com")` returns the GitHub-specific hint string; `"gitlab.com"` returns the GitLab hint; unknown host returns a generic fallback.
- `classifyCloneError`: matrix of `(host, stderr)` → `{ kind: "auth" | "not-found" | "network" | "unknown", hint }`.
- `cleanupTempClones` removes registered temp dirs; tolerates already-deleted dirs without throwing.

**Acceptance:** Each error-classification branch has at least one test; cleanup is verified end-to-end (write a temp dir, call cleanup, assert it's gone).

**Effort:** ~half a day.

---

## 11. CLI working-dir resolution (`electron/main/cli.ts`) — LOW

**Status:** `electron/main/cli.test.ts` covers basic arg-parsing. Working-dir resolution (temp dir vs configured vs default, when used with `--watch` and `--output-path`) is untested.

**Production file:** `electron/main/cli.ts`.

**Tests to add — extend `electron/main/cli.test.ts`:**
- `parseCliArgs(["runbooks", "/path/to/file.mdx"])` → `runbookPath` resolves to absolute
- `parseCliArgs(["runbooks", "github.com/owner/repo//path"])` → `remoteUrl` set, `runbookPath` null
- `parseCliArgs([…, "--watch", "--output-path", "out"])` → `watch: true, outputPath: <abs>`
- Mixed flags + positional argument: positional wins for runbook path
- Electron-internal flags filtered out: `--remote-debugging-port=9229`, `--no-sandbox`, `--enable-logging` should not be treated as a runbook path. (**See PR #120 review note** — the current filter only drops `--inspect*`.)

**Acceptance:** The Electron-internal-flag filter has explicit negative tests.

**Effort:** ~2 hours.

---

# Suggested order & landing strategy

Land in two PRs to keep review tractable:

**PR A — Security & high-risk (sections 3, 4, 5):**
- Token-injection refactor + tests
- Manifest applyDiff/cleanup safety tests
- Bash wrapper behavioural tests
- Roughly 2.5 days work.

**PR B — Coverage breadth (sections 1, 2, 6, 7, 10, 11):**
- CLI test framework + `test init` (the largest gap; consider its own PR if A+B are too big)
- Workspace truncation
- Remote-source resolution
- Electron remote-open UX
- CLI arg parsing edge cases
- Roughly 4 days work.

Section 8 (GitHub helpers) and section 9 (AWS allowlist) can be bundled into PR B or skipped if the helpers were dropped during the port — confirm with a quick grep before scheduling.

# Out of scope

- **Telemetry** (`src/telemetry.ts`, `electron/main/ipc/telemetry.ts`) — not actively used; no tests planned.
- **HTTP-server auth middleware** (`api/auth_enforcement_test.go`) — server is gone in Electron.
- **PTY support** (`api/exec_pty_test.go`) — removed entirely.
- **TfModule + TF templates** (`api/tf_*_test.go`) — feature removed.
- **`api/types_test.go`'s FlexibleBool** — Go JSON-tag concern, not applicable in TS.
