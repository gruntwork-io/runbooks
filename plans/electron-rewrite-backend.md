# Backend Migration: Go to TypeScript

Complete mapping of every Go source file to its TypeScript replacement.

## Module-by-Module Migration

### 1. `src/types.ts` (from `api/types.go`)

Port all shared interfaces:
- `File`, `FileTreeNode`, `FileTreeMeta`, `HeavyDir`
- `RenderRequest`, `RenderResponse`, `RenderInlineRequest`, `RenderInlineResponse`
- `BoilerplateVariable`, `BoilerplateVarType`, `ValidationRule`, `BoilerplateValidationType`
- `Section`, `BoilerplateConfig`, `OutputDependency`
- `FlexibleBool` (custom Zod schema or simple parser)

### 2. `src/path-validation.ts` (from `api/path_validation.go`)

Direct port of path security checks:
- `validateRelativePath()` - Ensures paths don't escape allowed directories
- `validateAbsolutePath()` - Validates absolute paths
- Uses `path.resolve()`, `path.relative()`, `path.normalize()` from Node.js

### 3. `src/mdx.ts` (from `api/mdx.go`)

MDX fence/block detection:
- `isMDXFence()` - Detects code block boundaries
- Simple string matching, direct port

### 4. `src/session/manager.ts` (from `api/session.go` + `api/session_handlers.go`)

Session management with token-based auth:
- `SessionManager` class with `createSession()`, `joinSession()`, `getSession()`, `resetSession()`, `deleteSession()`
- `Session`: validTokens Map, env Map, initialEnv, workingDir, executionCount, worktrees
- `SessionExecContext`: immutable snapshot for script execution
- Token generation: `crypto.randomUUID()`
- Thread safety: not needed in single-threaded Node.js (but guard async operations)
- Protected env var stripping (AWS credentials)

### 5. `src/exec/executor.ts` (from `api/exec.go`)

Script execution orchestration:
- `executeScript(req, session)` - Main entry point
- Creates temp files for RUNBOOK_OUTPUT and GENERATED_FILES
- Calls `prepareScript()` then starts PTY or pipe execution
- Environment setup: `setupExecEnvVars()` (RUNBOOK_OUTPUT, GENERATED_FILES, REPO_FILES)
- `mergeEnvVars()` for per-request overrides
- Returns async iterator or event emitter for streaming

### 6. `src/exec/script.ts` (from `api/exec_script.go`)

Script preparation:
- `prepareScriptForExecution(content, language)` - Writes temp file, detects interpreter
- Interpreter detection: bash, sh, python3, node based on shebang or language
- Bash wrapper for env capture (captures env after execution)
- Temp file cleanup

Use `os.tmpdir()` + `fs.mkdtemp()` instead of Go's `os.CreateTemp`.

### 7. `src/exec/pty.ts` - DROPPED

PTY support dropped. See [electron-rewrite-dropped.md](./electron-rewrite-dropped.md). No `node-pty` dependency. Script execution uses `child_process.spawn` with pipes only.

### 8. `src/exec/stream.ts` (from `api/exec_stream.go`)

Output processing:
- `streamExecutionOutput()` - Reads output channel, determines status, captures files/outputs
- File capture: copy files from GENERATED_FILES temp dir to output directory
- Output parsing: read RUNBOOK_OUTPUT file for key=value pairs
- File manifest updates
- Environment capture after execution (diff session env)

Instead of writing SSE events, emit IPC events or yield from async generator.

### 9. `src/workspace/file.ts` (from `api/file.go`)

File reading:
- `readFile(path)` - Read with 512KB truncation limit
- Language detection from extension
- `readRunbookFile(runbookPath)` - Read the runbook MDX content
- `resolveRunbookPath(path)` - Find runbook.mdx in directory

### 10. `src/workspace/file-tree.ts` (from `api/file_tree.go`)

Directory tree building:
- `buildFileTree(dir, maxFiles)` - Recursive directory scan
- File limit (500 files default), heavy directory detection
- Language detection, binary detection
- Returns `FileTreeNode[]` with truncation metadata

### 11. `src/workspace/workspace.ts` (from `api/workspace.go`)

Workspace operations:
- `getWorkspaceTree(worktreePath)` - File tree for git worktree
- `getWorkspaceDirs(worktreePath)` - Directory listing
- `readWorkspaceFile(worktreePath, filePath)` - File content with language/binary detection
- Image handling: base64 data URI for binary images
- Lazy-load support for large directories (>500 entries)

### 12. `src/workspace/changes.ts` (from `api/workspace.go` git section)

Git change detection:
- `getWorkspaceChanges(worktreePath)` - Run `git diff`, `git status`
- Parse diff output for additions/deletions
- Detect file renames, binary changes
- Git info: current ref, remote URL, commit SHA

Uses `execFile('git', ...)` for all git commands.

### 13. `src/files/manifest.ts` (from `api/file_manifest.go`)

File manifest tracking:
- `FileManifest` class - Tracks files from previous template render
- `computeManifest()` - Walk output directory, record file paths + hashes
- `diffManifest(old, new)` - Compute created/modified/deleted/skipped files
- Used for smart cleanup when template variables change

### 14. `src/files/generated.ts` (from `api/generated_files.go`)

Generated files management:
- `checkGeneratedFiles(workingDir, outputPath)` - Check if output directory has files
- `deleteGeneratedFiles(workingDir, outputPath)` - Remove generated files
- Returns file count for UI warning dialog

### 15. `src/watcher.ts` (from `api/watcher.go`)

File watching with chokidar:
```typescript
import chokidar from 'chokidar'

function createWatcher(runbookPath) {
  const dir = path.dirname(runbookPath)
  const watcher = chokidar.watch(dir, { ignoreInitial: true })
  // Debounce: 300ms (matching Go implementation)
  return watcher
}
```

### 16. `src/registry/executable.ts` (from `api/executable_registry.go` + `api/executable_handler.go`)

Executable registry:
- `ExecutableRegistry` class
- `buildRegistry(runbookPath)` - Parse MDX file, extract Command/Check components
- Uses regex to find `<Command>`, `<Check>` blocks and their props
- Extracts script content, language, template variable names
- Computes content hashes for validation
- `getExecutable(id)` - Lookup by ID
- `hasComponent(type)` - Check if block type exists (e.g., "AwsAuth")

Port the MDX parsing regex patterns from Go to JavaScript RegExp.

### 17. `src/boilerplate/config.ts` (from `api/boilerplate_config.go`)

Boilerplate config parsing (reimplemented in TypeScript):
- Parse `boilerplate.yml` as YAML using `yaml` npm package
- Extract variables: name, type, description, default, validations
- Handle types: `string`, `int`, `float`, `bool`, `list`, `map`, `enum`
- Extract x-extensions: `x-schema`, `x-schema-instance-label`, `x-section`
- Build section groupings for UI
- Extract output dependencies from template files (regex: `.outputs.blockId.outputName`)

**Note**: The Go code uses `bpConfig.ParseBoilerplateConfig()` from the boilerplate library for initial parsing, then does custom extraction for x-extensions. In TypeScript, parse YAML directly and extract everything in one pass since we control the full parsing.

Validation extraction:
- Map validation rule types to enum: required, regex, url, email, alphanumeric, alpha, digit, semver, length, custom
- Extract args from parameterized rules

### 18. `src/boilerplate/render.ts` (from `api/boilerplate_render.go`)

Template rendering orchestration:
- `renderBoilerplate(templateDir, variables, outputDir)` - Main render function
- Resolves template path relative to runbook directory
- Calls WASM for individual file rendering
- Walks template directory, renders each file
- Writes output files, computes file manifest
- Returns rendered file tree + cleanup stats (created/modified/deleted)

### 19. `src/boilerplate/wasm.ts`

WASM loader:
- Load brotli-compressed WASM from bundled asset
- Decompress with `zlib.brotliDecompressSync()`
- Instantiate with `WebAssembly.instantiate()`
- Expose render function: `renderTemplate(content, variables) -> string`

**Risk**: WASM API surface needs investigation. Check exports of the boilerplate WASM binary.

### 20. `src/aws/auth.ts` (from `api/aws_auth.go`)

AWS SDK v3 integration:
```typescript
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { IAMClient, ListAccountAliasesCommand } from '@aws-sdk/client-iam'
import { SSOClient, ListAccountsCommand, ListAccountRolesCommand } from '@aws-sdk/client-sso'
import { SSOOIDCClient, RegisterClientCommand, StartDeviceAuthorizationCommand, CreateTokenCommand } from '@aws-sdk/client-sso-oidc'
import { AccountClient, GetContactInformationCommand } from '@aws-sdk/client-account'
```

Functions to port:
- `validateCredentials(accessKey, secretKey, sessionToken, region)` - STS GetCallerIdentity
- `listProfiles()` - Parse ~/.aws/config and ~/.aws/credentials with `ini` package
- `startSsoFlow(startUrl, region)` - OIDC RegisterClient + StartDeviceAuthorization
- `pollSsoToken(clientId, clientSecret, deviceCode)` - OIDC CreateToken polling
- `completeSsoAuth(accessToken, accountId, roleName, region)` - SSO GetRoleCredentials
- `listSsoAccounts(accessToken)` - SSO ListAccounts
- `listSsoRoles(accessToken, accountId)` - SSO ListAccountRoles
- `detectEnvCredentials()` - Check process.env for AWS_ACCESS_KEY_ID etc.
- `checkRegion(region, credentials)` - Account API or EC2 DescribeRegions

### 21. `src/github/auth.ts` (from `api/github_auth.go`)

GitHub API via fetch:
- `validateToken(token)` - GET https://api.github.com/user
- `startOAuthDeviceFlow(clientId, scopes)` - POST https://github.com/login/device/code
- `pollOAuthToken(clientId, deviceCode, interval)` - POST https://github.com/login/oauth/access_token
- `listOrgs(token)` - GET https://api.github.com/user/orgs
- `listRepos(token, org)` - GET https://api.github.com/orgs/:org/repos
- `listRefs(token, owner, repo)` - GET https://api.github.com/repos/:owner/:repo/git/refs
- `detectEnvCredentials()` - Check process.env for GITHUB_TOKEN
- `detectCliCredentials()` - Run `gh auth token` via execFile

### 22. `src/github/pull-request.ts` (from `api/github_pull_request.go`)

PR creation:
- `createPullRequest(token, owner, repo, opts)` - GitHub REST API
- `pushBranch(worktreePath, branchName, token)` - git push via execFile
- `deleteBranch(worktreePath, branchName)` - git branch -d
- `listLabels(token, owner, repo)` - GitHub REST API

### 23. `src/git/clone.ts` (from `api/git_clone.go`)

Git clone with progress:
- `cloneRepository(url, localPath, ref, credentials)` - execFile('git', ['clone', ...])
- Progress parsing from git stderr (percentage, objects, etc.)
- Credential injection via GIT_ASKPASS helper script or environment
- Ref checkout after clone
- Returns file count, absolute path

Stream progress via callback or async iterator.

### 24. `src/git/operations.ts` (from `api/git_clone.go` remaining)

Git operations:
- `push(worktreePath, remote, branch, token)` - git push with credential injection
- `deleteBranch(worktreePath, branch)` - git branch -d
- `getCurrentBranch(worktreePath)` - git rev-parse --abbrev-ref HEAD
- `getRemoteUrl(worktreePath)` - git remote get-url origin

### 25. TF/HCL Parsing - DROPPED

See [electron-rewrite-dropped.md](./electron-rewrite-dropped.md). The `<TfModule>` component, `tf_parser.go`, `tf_parse_handler.go`, `files.go` (`IsBareTfModule`), and `--tf-runbook` flag are all removed.

### 26. `src/tf/generator.ts` (from `api/tf_generator.go` + `templates/tf/`) - DROPPED

Runbook generation from TF modules:
- Built-in templates: terragrunt, terragrunt-github, tofu
- Template content embedded as string constants (port from Go embed)
- `generateRunbook(templateName)` - Write template to temp dir, return path

### 27. `src/remote-source.ts` (from `api/remote_source.go` + `api/remote_token.go`)

Remote URL parsing:
- `parseRemoteSource(url)` - Parse GitHub/GitLab URLs
- Supports: HTTPS browser URLs, git:: prefix, OpenTofu registry format
- Returns: host, owner, repo, path, ref
- `downloadRemoteSource(parsed)` - Git clone to temp directory
- Token injection for authenticated clones

### 28. `src/telemetry.ts` (from `api/telemetry/telemetry.go`)

Mixpanel telemetry:
- Use `mixpanel` npm package (Node.js SDK)
- `init(version, disabled)` - Initialize with token
- `trackCommand(command)` - Track CLI command usage
- `printNotice()` - Display telemetry opt-out notice
- Respects RUNBOOKS_TELEMETRY_DISABLE env var and --no-telemetry flag

## Dependencies (package.json additions)

```json
{
  "dependencies": {
    "effect": "^3.21.0",

    "chokidar": "^5.0.0",
    "@aws-sdk/client-sts": "^3.1024.0",
    "@aws-sdk/client-iam": "^3.1024.0",
    "@aws-sdk/client-sso": "^3.1024.0",
    "@aws-sdk/client-sso-oidc": "^3.1024.0",
    "@aws-sdk/client-account": "^3.1024.0",

    "commander": "^14.0.0",
    "ini": "^6.0.0",
    "mixpanel": "^0.20.0",
    "electron-updater": "^6.8.0"
  },
  "devDependencies": {
    "electron": "^41.1.0",
    "electron-builder": "^26.8.0",
    "electron-vite": "^5.0.0"
  }
}
```

## Files Removed (Go)

All of these are deleted in Phase 8:
- `main.go`, `go.mod`, `go.sum`
- `api/*.go` (all 37 non-test files)
- `api/testing/*.go` (6 files)
- `api/telemetry/*.go`
- `cmd/*.go` (8 files)
- `browser/launch.go`
- `web/embed.go`
- `templates/tf/**/*.go`
