/**
 * IPC channel constants and type definitions.
 *
 * Shared between main process and renderer (via preload).
 * See plans/electron-rewrite-ipc.md for the full API specification.
 */

// ---------------------------------------------------------------------------
// Invoke channels (request/response, replaces REST GET/POST/DELETE)
// ---------------------------------------------------------------------------

export interface IpcChannelMap {
  // Runbook
  "runbook:get": {
    params: { path: string; watchMode?: boolean; remoteSource?: string }
    result: { path: string; content: string; contentHash: string; language: string; size: number; isWatchMode?: boolean; warnings?: string[]; remoteSource?: string; useExecutableRegistry?: boolean }
  }
  "runbook:open-remote": {
    params: { url: string }
    result: { path: string; remoteSource: string }
  }
  "runbook:executables": { params: void; result: { executables: Record<string, Executable>; warnings?: string[] } }
  "runbook:assets": { params: { filepath: string }; result: { data: Buffer; mimeType: string } }

  // Session
  "session:join": { params: void; result: { token: string } }
  "session:get": { params: void; result: SessionMetadata }
  "session:reset": { params: void; result: { ok: true } }
  "session:delete": { params: void; result: { ok: true } }
  "session:set-env": { params: { env: Record<string, string> }; result: { ok: true } }

  // Execution
  "exec:run": { params: ExecRequest; result: { status: { status: string; exitCode: number } | null } }
  "exec:cancel": { params: void; result: { ok: true } }

  // Boilerplate
  "boilerplate:variables": {
    params: { templatePath?: string; boilerplateContent?: string }
    result: BoilerplateConfig
  }
  "boilerplate:render": { params: RenderRequest; result: RenderResponse }
  "boilerplate:render-inline": { params: RenderInlineRequest; result: { renderedFiles: Record<string, { content: string; name?: string; path?: string; language?: string; size?: number; isTruncated?: boolean }>; message?: string; fileTree?: unknown; meta?: unknown } }

  // AWS Authentication
  "aws:validate": {
    params: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; region?: string; credentials?: AwsCredentials }
    result: { valid: boolean; accountId?: string; accountName?: string; arn?: string; error?: string }
  }
  "aws:profiles": {
    params: Record<string, never>
    result: { profiles: ProfileInfo[] }
  }
  "aws:sso-start": {
    params: { startUrl: string; region: string; accountId?: string; roleName?: string }
    result: { verificationUri: string; userCode: string; deviceCode: string; clientId: string; clientSecret: string; error?: string }
  }
  "aws:sso-roles": {
    params: { accessToken: string; accountId: string; region?: string }
    result: { roles: SsoRole[]; error?: string }
  }
  "aws:sso-poll": {
    params: { clientId: string; clientSecret: string; deviceCode: string; region?: string; accountId?: string; roleName?: string }
    result: {
      status?: string
      accessToken?: string
      pending?: boolean
      accounts?: SsoAccount[]
      accountId?: string
      accountName?: string
      arn?: string
      accessKeyId?: string
      secretAccessKey?: string
      sessionToken?: string
      error?: string
    }
  }
  "aws:sso-complete": {
    params: { accessToken: string; accountId: string; roleName: string; region: string }
    result: {
      credentials?: AwsCredentials
      accessKeyId?: string
      secretAccessKey?: string
      sessionToken?: string
      accountId?: string
      accountName?: string
      arn?: string
      error?: string
    }
  }
  "aws:env-credentials": {
    params: { prefix?: string; defaultRegion?: string }
    result: {
      found?: boolean
      detected?: boolean
      valid?: boolean
      credentials?: AwsCredentials
      accountId?: string
      accountName?: string
      arn?: string
      region?: string
      hasSessionToken?: boolean
      warning?: string
      error?: string
    }
  }
  "aws:env-credentials-confirm": {
    params: { prefix?: string; defaultRegion?: string }
    result: {
      valid?: boolean
      error?: string
      accountId?: string
      accountName?: string
      arn?: string
      accessKeyId?: string
      secretAccessKey?: string
      region?: string
      sessionToken?: string
    }
  }
  "aws:profile-auth": {
    params: { profileName: string; profile?: string }
    result: {
      valid?: boolean
      credentials?: AwsCredentials
      accessKeyId?: string
      secretAccessKey?: string
      sessionToken?: string
      accountId?: string
      accountName?: string
      arn?: string
      error?: string
    }
  }
  "aws:check-region": {
    params: { region: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; credentials?: AwsCredentials }
    result: { enabled: boolean; warning?: string }
  }

  // GitHub Authentication
  "github:validate": {
    // `host` is accepted for parity with gitlab:validate so the shared useGitAuth
    // hook passes one payload shape; the GitHub handler ignores it.
    params: { token: string; host?: string }
    result: { valid: boolean; user?: GitHubUser; scopes?: string[]; tokenType?: string; error?: string; status?: number }
  }
  "github:oauth-start": {
    params: { clientId: string; scopes: string[] }
    result: { deviceCode: string; userCode: string; verificationUri: string; interval: number; error?: string }
  }
  "github:oauth-poll": {
    params: { clientId: string; deviceCode: string }
    result: {
      status?: string
      token?: string
      pending?: boolean
      accessToken?: string
      user?: GitHubUser
      slowDown?: boolean
      error?: string
    }
  }
  "github:env-credentials": {
    params: { envVar?: string; prefix?: string; githubAuthId?: string; host?: string }
    result: {
      found: boolean
      valid?: boolean
      token?: string
      user?: GitHubUser
      scopes?: string[]
      tokenType?: string
      error?: string
      status?: number
    }
  }
  "github:cli-credentials": {
    params: { host?: string }
    result: {
      found: boolean
      token?: string
      user?: GitHubUser
      scopes?: string[]
      tokenType?: string
      error?: string
      status?: number
    }
  }
  "github:orgs": { params: void; result: GitHubOrg[] }
  "github:repos": { params: { org: string }; result: GitHubRepo[] }
  "github:refs": { params: { owner: string; repo: string }; result: GitHubRef[] }
  "github:labels": { params: { owner: string; repo: string }; result: { labels?: string[] } }

  // GitLab Authentication
  // Enumerate the GitLab hosts the user is logged into via glab (for the host
  // picker). `defaultHost` is glab's configured default (falls back to gitlab.com).
  "gitlab:enumerate-hosts": {
    params: Record<string, never>
    result: { hosts: string[]; defaultHost: string }
  }
  "gitlab:validate": {
    // The GitLab instance to validate against (default gitlab.com). `host` is a
    // bare host from the picker (or an authored `host` prop); `instanceUrl` is a
    // manually-entered instance URL that overrides `host` when present.
    params: { token: string; host?: string; instanceUrl?: string }
    result: { valid: boolean; user?: GitHubUser; scopes?: string[]; tokenType?: string; error?: string; status?: number }
  }
  "gitlab:env-credentials": {
    // Param keys mirror github:env-credentials so the shared useGitAuth hook can
    // call either channel with one payload shape; the gitlab handler ignores
    // envVar/githubAuthId. `host` (picker) or `instanceUrl` (manual field,
    // overrides `host`) selects the instance to validate against.
    params: { envVar?: string; prefix?: string; githubAuthId?: string; host?: string; instanceUrl?: string }
    result: {
      found: boolean
      valid?: boolean
      token?: string
      user?: GitHubUser
      scopes?: string[]
      tokenType?: string
      error?: string
      status?: number
      host?: string
    }
  }
  "gitlab:cli-credentials": {
    // `host` selects which glab-configured instance to detect (default: glab's
    // own default host); `instanceUrl` (manual field) overrides it when present.
    params: { host?: string; instanceUrl?: string }
    result: {
      found: boolean
      token?: string
      user?: GitHubUser
      scopes?: string[]
      tokenType?: string
      error?: string
      status?: number
      host?: string
    }
  }
  // `host` is the GitLab instance host the repo lives on (self-hosted or
  // gitlab.com), derived by the renderer from the repo's remote URL.
  "gitlab:labels": { params: { owner: string; repo: string; host?: string }; result: { labels?: string[] } }

  // Git Operations
  "git:clone": {
    params: GitCloneRequest
    result: { status: string; error?: string; fileCount?: number; absolutePath?: string; relativePath?: string; outputs?: Record<string, string> }
  }
  "git:push": { params: { worktreePath: string; branchName: string; provider?: "github" | "gitlab" }; result: { ok: true } | { error: string } }
  "git:pull-request": { params: PullRequestRequest; result: { url: string; number: number } | { error: string } }
  "git:merge-request": { params: PullRequestRequest; result: { url: string; number: number } | { error: string } }
  "git:delete-branch": { params: { worktreePath: string; branch: string }; result: { ok: true } }

  // Workspace
  "workspace:tree": {
    params: { worktreePath: string; subpath?: string }
    result: { tree: WorkspaceTreeNode[]; totalFiles: number; gitInfo?: { branch: string; remoteUrl: string; commitSha: string } }
  }
  "workspace:dirs": { params: { worktreePath: string }; result: { dirs?: string[] } }
  "workspace:file": {
    params: { worktreePath: string; filePath: string }
    result: WorkspaceFileResponse
  }
  "workspace:changes": {
    params: { worktreePath: string; singleFile?: string }
    result: { changes: WorkspaceChange[]; totalChanges: number; tooManyChanges?: boolean }
  }
  "workspace:register": { params: { worktreePath: string }; result: { ok: true } }
  "workspace:set-active": { params: { worktreePath: string }; result: { ok: true } }

  // Generated Files
  "generated-files:check": { params: void; result: { hasFiles: boolean; fileCount: number } }
  "generated-files:delete": { params: void; result: { ok: true; success?: boolean; deletedCount?: number; message?: string } }

  // File Operations
  "file:read": { params: { path: string }; result: FileData }

  // Watch Mode
  "watch:subscribe": { params: void; result: { ok: true } }

  // Telemetry
  "telemetry:config": { params: void; result: { enabled: boolean; token?: string; anonymousId?: string; version?: string } }

  // CLI
  "cli:check-install": {
    params: void
    result: { installed: boolean; symlinkPath?: string; targetPath?: string; platform: string }
  }
  "cli:install": {
    params: void
    result: { ok: true; symlinkPath: string }
  }
  "cli:uninstall": {
    params: void
    result: { ok: true }
  }

  // Native (Electron-only)
  "native:open-external": { params: { url: string }; result: { ok: true } }
  "native:show-open-dialog": {
    params: { properties: string[]; filters?: Array<{ name: string; extensions: string[] }> }
    result: { filePaths: string[] }
  }
  "native:open-runbook-dialog": { params: void; result: { ok: boolean } }
  "native:close-runbook": { params: void; result: { ok: true } }
  "native:get-app-info": { params: void; result: { version: string; platform: string; arch: string } }
  "native:get-cli-config": {
    params: void
    result: {
      runbookPath?: string
      remoteUrl?: string
      watch?: boolean
      outputPath?: string
      noTelemetry?: boolean
      disableLiveFileReload?: boolean
    }
  }
  "native:set-theme": {
    params: { theme: "light" | "dark" | "system" }
    result: { ok: true }
  }
}

// ---------------------------------------------------------------------------
// Send channels (server-to-client events, replaces SSE)
// ---------------------------------------------------------------------------

export interface IpcEventMap {
  "exec:log": { line: string; timestamp: string; replace?: boolean }
  "exec:log-file": { path: string }
  "exec:status": { status: string; exitCode: number }
  "exec:outputs": { outputs: Record<string, string> }
  "exec:files-captured": { files: string[]; count: number; fileTree: unknown }
  "watch:file-change": { type: "reload" }
  "git:clone-progress": { line: string; timestamp: string }
  "git:log": { line: string; timestamp: string; replace?: boolean }
  "git:status": { status: string; exitCode: number }
  "git:pr-result": { prUrl: string; prNumber: number; branchName: string }
  "git:outputs": { outputs: Record<string, string> }
  "git:error": { message?: string; code?: string; branchName?: string }
  "file:open-runbook": { path: string; remoteSource?: string }
  "menu:open-url-prompt": void
  "menu:close-runbook": void
  "menu:preferences": void
  "registry:updated": void
}

// ---------------------------------------------------------------------------
// Channel name helpers
// ---------------------------------------------------------------------------

export type InvokeChannel = keyof IpcChannelMap
export type EventChannel = keyof IpcEventMap

export interface Executable {
  id: string
  type: string
  content: string
  language: string
  hash: string
  componentId?: string
}

export interface SessionMetadata {
  workingDir: string
  executionCount: number
  env: Record<string, string>
}

export interface ExecRequest {
  executableId?: string
  componentId?: string
  templateVarValues?: Record<string, unknown>
  envVarsOverride?: Record<string, string>
  usePty?: boolean
  /** Per-execution timeout in milliseconds. Falls back to the executor's default when omitted. */
  timeoutMs?: number
}

export interface BoilerplateConfig {
  variables: BoilerplateVariable[]
  sections: Section[]
}

export interface BoilerplateVariable {
  name: string
  type: string
  description?: string
  default?: unknown
}

export interface Section {
  name: string
  description?: string
  variables: string[]
}

export interface RenderRequest {
  templatePath: string
  variables: Record<string, unknown>
  outputPath: string
}

export interface RenderResponse {
  files: string[]
  created: number
  modified: number
  deleted: number
}

export interface RenderInlineRequest {
  template?: string
  templateFiles?: Record<string, string>
  variables?: Record<string, unknown>
  inputs?: Array<{ name: string; value: unknown }>
  generateFile?: boolean
  outputPath?: string
}

export interface ProfileInfo {
  name: string
  ssoStartUrl?: string
  ssoRegion?: string
  region?: string
}

export interface SsoRole {
  roleName: string
  accountId: string
}

export interface SsoAccount {
  accountId: string
  accountName: string
  emailAddress?: string
}

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
}

export interface GitHubUser {
  login: string
  name?: string
  avatarUrl?: string
}

export interface GitHubOrg {
  login: string
  name?: string
}

export interface GitHubRepo {
  name: string
  fullName: string
  private: boolean
  defaultBranch: string
}

export interface GitHubRef {
  ref: string
  type: "branch" | "tag"
}

export interface GitCloneRequest {
  url: string
  localPath?: string
  local_path?: string
  ref?: string
  repo_path?: string
  credentials?: { token: string }
  /**
   * Provider of the linked Git Auth block ("github" | "gitlab"). Selects which
   * session token authenticates a private clone, independent of the remote
   * hostname — required for self-hosted instances. Omitted by callers with no
   * linked auth block, in which case the backend falls back to the well-known
   * SaaS hostnames.
   */
  provider?: "github" | "gitlab"
  use_pty?: boolean
  force?: boolean
}

export interface PullRequestRequest {
  worktreePath: string
  owner: string
  repo: string
  title: string
  body?: string
  baseBranch: string
  headBranch: string
  commitMessage: string
  labels?: string[]
}

export interface WorkspaceTreeNode {
  name: string
  path: string
  type: "file" | "directory"
  language?: string
  children?: WorkspaceTreeNode[]
}

export interface WorkspaceFileResponse {
  content: string
  language?: string
  isBinary: boolean
  path: string
  size: number
}

export interface WorkspaceChange {
  path: string
  status: string
  additions: number
  deletions: number
}

export interface FileData {
  content: string
  language?: string
  path: string
  isBinary: boolean
}
