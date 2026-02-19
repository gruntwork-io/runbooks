Previously, opening a runbook required having the repository cloned locally. If someone shared a GitHub link to a runbook, you had to clone the repo, find the right directory, and run `runbooks open ./path/to/runbook`. This was friction for runbook consumers who just want to run a runbook they were sent a link to.

This PR adds remote runbook support — you can now pass a GitHub or GitLab URL directly to `runbooks open`, `runbooks watch`, or `runbooks serve`, and the tool downloads just what it needs and serves it immediately.

Major changes:

- **Remote URL parsing.** A unified parser that accepts six URL formats and normalizes them into a single internal representation.
- **Sparse git clone.** When a URL points to a subdirectory, only that directory is cloned — not the entire repo.
- **Frontend remote awareness.** The UI displays the original remote URL in the header instead of a temp directory path, with a button to copy the local path.

## Remote URL parsing

`ParseRemoteSource` in `api/remote_source.go` accepts any of the following formats and normalizes them into a `ParsedRemoteSource` struct:

```bash
# GitHub browser URLs (copy/paste from your browser)
runbooks open https://github.com/org/repo/tree/main/runbooks/setup-vpc
runbooks open https://github.com/org/repo/blob/main/runbooks/setup-vpc/runbook.mdx

# GitLab browser URLs
runbooks open https://gitlab.com/org/repo/-/tree/main/runbooks/setup-vpc

# OpenTofu-style source strings
runbooks open github.com/org/repo//runbooks/setup-vpc?ref=v1.0
runbooks open "git::https://github.com/org/repo.git//runbooks/setup-vpc?ref=main"
```

- **Ambiguous ref resolution.** Browser URLs embed the git ref and repo path in a single string (e.g., `/tree/main/runbooks/setup-vpc`). The parser uses `git ls-remote` to enumerate all branches and tags, then matches the longest prefix to correctly handle branch names containing slashes. Falls back to splitting on the first `/` if `ls-remote` fails.
- **Blob URL handling.** When the URL uses `/blob/` (pointing to a file), the path is automatically adjusted to the parent directory, since runbooks are directory-based.
- **Local path passthrough.** If the input doesn't match any remote format, `ParseRemoteSource` returns `nil, nil` and the CLI treats it as a local path — no behavior change for existing users.

## Authentication and token handling

`GetTokenForHost` in `api/remote_token.go` discovers auth tokens without any configuration:

- **GitHub:** checks `GITHUB_TOKEN` → `GH_TOKEN` → `gh auth token`
- **GitLab:** checks `GITLAB_TOKEN` → `glab auth token`
- **Public repos work without any token.** The token is only needed for private repos.
- **Tokens are never written to disk or logged.** `SanitizeGitError` strips tokens from any error messages before they reach the user.
- **Actionable error messages.** Auth failures produce specific guidance depending on whether a token was absent or invalid:
  - No token: `authentication required for github.com/org/repo: set GITHUB_TOKEN, or run 'gh auth login'`
  - Invalid/expired token: `authentication failed for github.com/org/repo (token may be invalid or expired): verify GITHUB_TOKEN, or re-run 'gh auth login'`

## Sparse git clone

When the URL points to a subdirectory within a repo, `downloadRemoteRunbook` in `cmd/remote_open.go` uses `git sparse-checkout` to clone only that directory — avoiding downloading the entire repository.

- **Full clone fallback.** If the URL points to a repo root (no subdirectory path), a standard `git clone --depth 1` is used instead.
- **Size guard.** After cloning, a warning is emitted to stderr if the downloaded content exceeds 50 MB.
- **Temp directory lifecycle.** The clone goes into an `os.MkdirTemp` directory. A cleanup function is returned and deferred by the calling command, so the temp directory is removed when the process exits.
- **Automatic `--working-dir-tmp`.** When opening a remote runbook, if no `--working-dir` is specified, the working directory automatically becomes a temp directory (equivalent to `--working-dir-tmp`). This prevents generated files from being written into the cloned runbook directory.

## Frontend remote awareness

When the API response includes a `remoteSource` field (the original URL), the frontend adjusts its display:

- **Header shows the remote URL.** `App.tsx` prefers `remoteSource` over `path` for the display string passed to `Header`.
- **Copy local path button.** When viewing a remote runbook, a folder icon appears next to the URL in the header. Clicking it copies the local temp directory path to the clipboard, with a tooltip showing the full path.
- **Mobile-friendly.** On small viewports, the `https://` prefix is stripped for a more compact display.

## `RunbookConfig` struct

The three booleans/strings previously threaded through handler functions (`runbookPath`, `isWatchMode`, `useExecutableRegistry`) are now bundled into a `RunbookConfig` struct in `api/file.go`, with the new `RemoteSourceURL` field added alongside them:

```go
type RunbookConfig struct {
    LocalPath             string
    RemoteSourceURL       string
    IsWatchMode           bool
    UseExecutableRegistry bool
}
```

All three server entry points (`StartServer`, `StartBackendServer`, `StartServerWithWatch`) now accept a `remoteSourceURL` parameter and construct a `RunbookConfig` to pass to `HandleRunbookRequest`.

## Additional details and improvements

### `FileMetadata` struct and `readFileMetadata` refactor

`api/file.go` now uses a `FileMetadata` struct with a `ToJSON()` method instead of directly building `gin.H` maps. Error handling is extracted into a `sendFileError` helper. This eliminates the previous pattern where `readFileMetadata` both read the file and sent HTTP error responses via the gin context.

### `ValidateAbsolutePathInDir`

`api/path_validation.go` extracts a new `ValidateAbsolutePathInDir(path, dir)` function from the existing `ValidateAbsolutePathInCwd`. The old function now delegates to the new one with `os.Getwd()`. This is needed because remote runbooks use a temp working directory that differs from the process CWD, and `generated_files.go` needs to validate paths against that directory.

### `resolveWorkingDir` gains `isRemote` parameter

`resolveWorkingDir` in `cmd/root.go` now accepts an `isRemote bool` parameter. When true and no explicit `--working-dir` is configured, it automatically enables temp directory mode. This replaces the previous approach of mutating the `workingDirTmp` package variable.

### `ResolveRunbookPath` simplified

`api/watcher.go`: `ResolveRunbookPath` no longer tries `runbook.md` as a fallback — it only looks for `runbook.mdx`. The error message now specifies what was expected.

### Test refactors

`api/file_test.go` is significantly reduced (from ~700 lines to ~230) by extracting test helpers (`runbookRequest`, etc.) that eliminate repeated router/request boilerplate. `cmd/remote_open_test.go` covers URL parsing integration, auth hint generation, and clone error classification.
