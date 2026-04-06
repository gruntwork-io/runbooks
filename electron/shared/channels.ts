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
    result: { path: string; content: string; contentHash: string; language: string; size: number; isWatchMode: boolean; warnings: string[]; remoteSource?: string }
  }
  "runbook:open-remote": {
    params: { url: string }
    result: { path: string; remoteSource: string }
  }
  "runbook:executables": { params: void; result: Executable[] }
  "runbook:assets": { params: { filepath: string }; result: { data: Buffer; mimeType: string } }

  // Session
  "session:create": { params: { workingDir: string }; result: { token: string } }
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
  "boilerplate:render-inline": { params: RenderInlineRequest; result: RenderInlineResponse }

  // AWS Authentication
  "aws:validate": {
    params: { accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string }
    result: { valid: boolean; accountId?: string; accountName?: string; arn?: string; error?: string }
  }
  "aws:profiles": { params: void; result: ProfileInfo[] }
  "aws:sso-start": {
    params: { startUrl: string; region: string }
    result: { verificationUri: string; userCode: string; deviceCode: string; clientId: string; clientSecret: string }
  }
  "aws:sso-roles": { params: { accessToken: string; accountId: string }; result: { roles: SsoRole[] } }
  "aws:sso-poll": {
    params: { clientId: string; clientSecret: string; deviceCode: string }
    result: { accessToken?: string; pending?: boolean }
  }
  "aws:sso-complete": {
    params: { accessToken: string; accountId: string; roleName: string; region: string }
    result: { credentials: AwsCredentials }
  }
  "aws:env-credentials": { params: void; result: { detected: boolean; credentials?: AwsCredentials } }
  "aws:env-credentials-confirm": { params: void; result: { ok: true } }
  "aws:profile-auth": { params: { profileName: string }; result: { credentials: AwsCredentials } }
  "aws:check-region": { params: { region: string }; result: { enabled: boolean } }

  // GitHub Authentication
  "github:validate": { params: { token: string }; result: { valid: boolean; user?: GitHubUser } }
  "github:oauth-start": {
    params: { clientId: string; scopes: string[] }
    result: { deviceCode: string; userCode: string; verificationUri: string; interval: number }
  }
  "github:oauth-poll": {
    params: { clientId: string; deviceCode: string }
    result: { token?: string; pending?: boolean }
  }
  "github:env-credentials": { params: void; result: { detected: boolean; token?: string } }
  "github:cli-credentials": { params: void; result: { detected: boolean; token?: string } }
  "github:orgs": { params: void; result: GitHubOrg[] }
  "github:repos": { params: { org: string }; result: GitHubRepo[] }
  "github:refs": { params: { owner: string; repo: string }; result: GitHubRef[] }
  "github:labels": { params: { owner: string; repo: string }; result: string[] }

  // Git Operations
  "git:clone": {
    params: GitCloneRequest
    result: { fileCount: number; absolutePath: string; relativePath: string }
  }
  "git:push": { params: { worktreePath: string; remote: string; branch: string }; result: { ok: true } }
  "git:pull-request": { params: PullRequestRequest; result: { url: string; number: number } }
  "git:delete-branch": { params: { worktreePath: string; branch: string }; result: { ok: true } }

  // Workspace
  "workspace:tree": {
    params: { worktreePath: string; subpath?: string }
    result: WorkspaceTreeNode[]
  }
  "workspace:dirs": { params: { worktreePath: string }; result: string[] }
  "workspace:file": {
    params: { worktreePath: string; filePath: string }
    result: WorkspaceFileResponse
  }
  "workspace:changes": {
    params: { worktreePath: string }
    result: { changes: WorkspaceChange[]; gitInfo: GitInfo }
  }
  "workspace:register": { params: { worktreePath: string }; result: { ok: true } }
  "workspace:set-active": { params: { worktreePath: string }; result: { ok: true } }

  // Generated Files
  "generated-files:check": { params: void; result: { hasFiles: boolean; fileCount: number } }
  "generated-files:delete": { params: void; result: { ok: true } }

  // File Operations
  "file:read": { params: { path: string }; result: FileData }

  // Watch Mode
  "watch:subscribe": { params: void; result: { ok: true } }

  // Telemetry
  "telemetry:config": { params: void; result: { enabled: boolean; token?: string } }

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
  "native:get-app-info": { params: void; result: { version: string; platform: string; arch: string } }
  "native:get-cli-config": {
    params: void
    result: {
      runbookPath?: string
      remoteUrl?: string
      watch?: boolean
      workingDir?: string
      outputPath?: string
      noTelemetry?: boolean
    }
  }
}

// ---------------------------------------------------------------------------
// Send channels (server-to-client events, replaces SSE)
// ---------------------------------------------------------------------------

export interface IpcEventMap {
  "exec:log": { line: string; timestamp: string; replace?: boolean }
  "exec:status": { status: string; exitCode: number }
  "exec:outputs": { outputs: Record<string, string> }
  "exec:files-captured": { files: string[]; count: number; fileTree: unknown }
  "exec:error": { message: string; details?: string }
  "watch:file-change": { type: "reload" }
  "git:clone-progress": { line: string; timestamp: string }
  "git:push-progress": { line: string; timestamp: string }
  "menu:open-url-prompt": void
}

// ---------------------------------------------------------------------------
// Channel name helpers
// ---------------------------------------------------------------------------

export type InvokeChannel = keyof IpcChannelMap
export type EventChannel = keyof IpcEventMap

// ---------------------------------------------------------------------------
// Placeholder types — will be replaced by src/types.ts as modules are built
// ---------------------------------------------------------------------------

export interface Executable {
  id: string
  type: string
  content: string
  language: string
  hash: string
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
  template: string
  variables: Record<string, unknown>
}

export interface RenderInlineResponse {
  content: string
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
  localPath: string
  ref?: string
  credentials?: { token: string }
}

export interface PullRequestRequest {
  worktreePath: string
  owner: string
  repo: string
  title: string
  body?: string
  baseBranch: string
  headBranch: string
  labels?: string[]
  token: string
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
}

export interface WorkspaceChange {
  path: string
  status: string
  additions: number
  deletions: number
}

export interface GitInfo {
  branch: string
  remoteUrl?: string
  commitSha?: string
}

export interface FileData {
  content: string
  language?: string
  path: string
  isBinary: boolean
}
