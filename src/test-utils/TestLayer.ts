import { Effect, Layer, Stream } from "effect"
import { makeTestFileSystem } from "./TestFileSystem.ts"
import { makeTestSpawner } from "./TestSpawner.ts"
import type { SpawnExpectation } from "./TestSpawner.ts"
import { makeTestEnvironment } from "./TestEnvironment.ts"
import { AwsClient } from "../services/AwsClient.ts"
import type { AwsClientShape } from "../services/AwsClient.ts"
import { GitHubClient } from "../services/GitHubClient.ts"
import type { GitHubClientShape } from "../services/GitHubClient.ts"
import { GitClient } from "../services/GitClient.ts"
import type { GitClientShape } from "../services/GitClient.ts"
import { BoilerplateRenderer } from "../services/BoilerplateRenderer.ts"
import type { BoilerplateRendererShape } from "../services/BoilerplateRenderer.ts"
import { Telemetry } from "../services/Telemetry.ts"
import type { TelemetryShape } from "../services/Telemetry.ts"
import {
  AwsAuthError,
  AwsConfigError,
  AwsSsoError,
  GitHubApiError,
  GitError,
} from "../errors/index.ts"

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

const notConfigured = (service: string, method: string) =>
  `TestLayer: ${service}.${method} not configured`

const makeStubAwsClient = (overrides: Partial<AwsClientShape> = {}): AwsClientShape => ({
  validateCredentials: (_creds, _region) =>
    Effect.fail(new AwsAuthError({ message: notConfigured("AwsClient", "validateCredentials") })),
  listProfiles: () =>
    Effect.fail(new AwsConfigError({ message: notConfigured("AwsClient", "listProfiles") })),
  authenticateProfile: (_profileName) =>
    Effect.fail(new AwsAuthError({ message: notConfigured("AwsClient", "authenticateProfile") })),
  startSsoDeviceAuth: (_startUrl, _region) =>
    Effect.fail(new AwsSsoError({ message: notConfigured("AwsClient", "startSsoDeviceAuth") })),
  pollSsoToken: (_params) =>
    Effect.fail(new AwsSsoError({ message: notConfigured("AwsClient", "pollSsoToken") })),
  completeSsoAuth: (_params) =>
    Effect.fail(new AwsSsoError({ message: notConfigured("AwsClient", "completeSsoAuth") })),
  listSsoAccounts: (_accessToken) =>
    Effect.fail(new AwsSsoError({ message: notConfigured("AwsClient", "listSsoAccounts") })),
  listSsoRoles: (_accessToken, _accountId) =>
    Effect.fail(new AwsSsoError({ message: notConfigured("AwsClient", "listSsoRoles") })),
  checkRegion: (_region, _creds) =>
    Effect.fail(new AwsAuthError({ message: notConfigured("AwsClient", "checkRegion") })),
  ...overrides,
})

const makeStubGitHubClient = (overrides: Partial<GitHubClientShape> = {}): GitHubClientShape => ({
  validateToken: (_token) =>
    Effect.fail(new GitHubApiError({ status: 0, message: notConfigured("GitHubClient", "validateToken") })),
  detectTokenType: (_token) => "unknown" as const,
  startOAuthDeviceFlow: (_clientId, _scopes) =>
    Effect.fail(new GitHubApiError({ status: 0, message: notConfigured("GitHubClient", "startOAuthDeviceFlow") })),
  pollOAuthToken: (_clientId, _deviceCode) =>
    Effect.fail(new GitHubApiError({ status: 0, message: notConfigured("GitHubClient", "pollOAuthToken") })),
  listOrgs: (_token) =>
    Effect.fail(new GitHubApiError({ status: 0, message: notConfigured("GitHubClient", "listOrgs") })),
  listRepos: (_token, _owner, _query) =>
    Effect.fail(new GitHubApiError({ status: 0, message: notConfigured("GitHubClient", "listRepos") })),
  listRefs: (_token, _owner, _repo, _query) =>
    Effect.fail(new GitHubApiError({ status: 0, message: notConfigured("GitHubClient", "listRefs") })),
  listLabels: (_token, _owner, _repo) =>
    Effect.fail(new GitHubApiError({ status: 0, message: notConfigured("GitHubClient", "listLabels") })),
  createPullRequest: (_token, _params) =>
    Effect.fail(new GitHubApiError({ status: 0, message: notConfigured("GitHubClient", "createPullRequest") })),
  addLabels: (_token, _owner, _repo, _prNumber, _labels) =>
    Effect.fail(new GitHubApiError({ status: 0, message: notConfigured("GitHubClient", "addLabels") })),
  ...overrides,
})

const makeStubGitClient = (overrides: Partial<GitClientShape> = {}): GitClientShape => ({
  clone: (_url, _dest, _options) =>
    Stream.fail(new GitError({ command: "clone", stderr: notConfigured("GitClient", "clone"), exitCode: 1 })),
  cloneSimple: (_url, _dest, _options) =>
    Effect.fail(new GitError({ command: "clone", stderr: notConfigured("GitClient", "cloneSimple"), exitCode: 1 })),
  push: (_repoPath, _remote, _branch, _options) =>
    Effect.fail(new GitError({ command: "push", stderr: notConfigured("GitClient", "push"), exitCode: 1 })),
  deleteBranch: (_repoPath, _branch) =>
    Effect.fail(new GitError({ command: "branch -D", stderr: notConfigured("GitClient", "deleteBranch"), exitCode: 1 })),
  getCurrentBranch: (_repoPath) =>
    Effect.fail(new GitError({ command: "branch", stderr: notConfigured("GitClient", "getCurrentBranch"), exitCode: 1 })),
  getRemoteUrl: (_repoPath) =>
    Effect.fail(new GitError({ command: "remote", stderr: notConfigured("GitClient", "getRemoteUrl"), exitCode: 1 })),
  getInfo: (_repoPath) =>
    Effect.fail(new GitError({ command: "info", stderr: notConfigured("GitClient", "getInfo"), exitCode: 1 })),
  diff: (_repoPath, _filePath) =>
    Effect.fail(new GitError({ command: "diff", stderr: notConfigured("GitClient", "diff"), exitCode: 1 })),
  status: (_repoPath) =>
    Effect.fail(new GitError({ command: "status", stderr: notConfigured("GitClient", "status"), exitCode: 1 })),
  hasCommits: (_repoPath) =>
    Effect.fail(new GitError({ command: "log", stderr: notConfigured("GitClient", "hasCommits"), exitCode: 1 })),
  hasChanges: (_repoPath) =>
    Effect.fail(new GitError({ command: "status", stderr: notConfigured("GitClient", "hasChanges"), exitCode: 1 })),
  checkIgnored: (_repoPath, _paths) =>
    Effect.fail(new GitError({ command: "check-ignore", stderr: notConfigured("GitClient", "checkIgnored"), exitCode: 1 })),
  createBranch: (_repoPath, _branch) =>
    Effect.fail(new GitError({ command: "checkout -b", stderr: notConfigured("GitClient", "createBranch"), exitCode: 1 })),
  stageAll: (_repoPath) =>
    Effect.fail(new GitError({ command: "add", stderr: notConfigured("GitClient", "stageAll"), exitCode: 1 })),
  commit: (_repoPath, _message, _allowEmpty) =>
    Effect.fail(new GitError({ command: "commit", stderr: notConfigured("GitClient", "commit"), exitCode: 1 })),
  ...overrides,
})

const makeStubBoilerplate = (overrides: Partial<BoilerplateRendererShape> = {}): BoilerplateRendererShape => ({
  renderFile: (templateContent, _variables) => Effect.succeed(templateContent),
  renderTemplate: (_templateDir, _outputDir, _variables) => Effect.void,
  ...overrides,
})

const makeStubTelemetry = (overrides: Partial<TelemetryShape> = {}): TelemetryShape => ({
  track: (_event, _properties) => Effect.void,
  trackCommand: (_command) => Effect.void,
  trackError: (_errorType) => Effect.void,
  isEnabled: () => Effect.succeed(false),
  ...overrides,
})

// ---------------------------------------------------------------------------
// Public layer factories
// ---------------------------------------------------------------------------

export const makeTestAwsClient = (overrides: Partial<AwsClientShape> = {}) =>
  Layer.succeed(AwsClient, makeStubAwsClient(overrides))

export const makeTestGitHubClient = (overrides: Partial<GitHubClientShape> = {}) =>
  Layer.succeed(GitHubClient, makeStubGitHubClient(overrides))

export const makeTestGitClient = (overrides: Partial<GitClientShape> = {}) =>
  Layer.succeed(GitClient, makeStubGitClient(overrides))

export const makeTestBoilerplate = (overrides: Partial<BoilerplateRendererShape> = {}) =>
  Layer.succeed(BoilerplateRenderer, makeStubBoilerplate(overrides))

export const makeTestTelemetry = (overrides: Partial<TelemetryShape> = {}) =>
  Layer.succeed(Telemetry, makeStubTelemetry(overrides))

// ---------------------------------------------------------------------------
// Combined test layer
// ---------------------------------------------------------------------------

export interface TestLayerOptions {
  readonly files?: Record<string, string>
  readonly commands?: SpawnExpectation[]
  readonly env?: Record<string, string>
  readonly aws?: Partial<AwsClientShape>
  readonly github?: Partial<GitHubClientShape>
  readonly git?: Partial<GitClientShape>
  readonly boilerplate?: Partial<BoilerplateRendererShape>
  readonly telemetry?: Partial<TelemetryShape>
}

export const makeTestLayer = (options: TestLayerOptions = {}) =>
  Layer.mergeAll(
    makeTestFileSystem(options.files),
    makeTestSpawner(options.commands),
    makeTestEnvironment(options.env),
    makeTestAwsClient(options.aws),
    makeTestGitHubClient(options.github),
    makeTestGitClient(options.git),
    makeTestBoilerplate(options.boilerplate),
    makeTestTelemetry(options.telemetry),
  )
