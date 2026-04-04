# Dependency Injection & Abstraction Boundaries (Effect)

All external side-effects are modeled as Effect services with typed errors and requirements. Concrete implementations are provided as Layers, composed at the application root (Electron main process or CLI entry point). This gives us compile-time dependency verification, structured error handling, resource safety, and trivial test mocking — all from one library.

**Reference**: https://effect.website/docs

## Why Effect

Effect replaces several ad-hoc patterns with a unified model:

| Concern | Without Effect | With Effect |
|---------|---------------|-------------|
| DI | Constructor injection, manual wiring | Services (`Context.Tag`) + Layers, compiler-verified |
| Error handling | try/catch, error codes, inconsistent | Typed error channel (`Effect<A, E, R>`), composable |
| Resource cleanup | try/finally, manual cleanup functions | `Scope` + `acquireRelease`, guaranteed finalizers |
| Streaming output | AsyncIterable, EventEmitter, callbacks | `Stream<A, E, R>`, composable with backpressure |
| Concurrency | Raw Promise.all, manual cancellation | Fibers, structured concurrency, interruption |
| Testing | Mock constructors, DI containers | Swap Layers, compiler ensures all deps provided |

## Core Concepts Used

- **`Effect<Success, Error, Requirements>`** — lazy description of a computation. `Requirements` tracks which services are needed at the type level. (https://effect.website/docs/getting-started/the-effect-type)
- **`Context.Tag`** — defines a service identity and its interface. (https://effect.website/docs/requirements-management/services)
- **`Layer<Out, Error, In>`** — blueprint for constructing a service from its dependencies. Layers compose to build the full dependency graph. (https://effect.website/docs/requirements-management/layers)
- **`ManagedRuntime`** — creates a runtime from a Layer for use in non-Effect code (IPC handlers, CLI). (https://effect.website/docs/runtime)
- **`Scope`** + **`acquireRelease`** — guarantees resource cleanup (temp files, watchers, WASM). (https://effect.website/docs/resource-management/scope)
- **`Stream`** — effectful, lazy, composable stream of values for exec output, git clone progress, etc.
- **`Data.TaggedError`** — typed error classes with discriminant tags for precise error handling. (https://effect.website/docs/error-management/expected-errors)
- **`Effect.gen`** — generator syntax for readable sequential composition. (https://effect.website/docs/getting-started/using-generators)

## Architecture

```
src/
  services/           # Service definitions (Context.Tag + interface)
    FileSystem.ts
    ProcessSpawner.ts
    AwsClient.ts
    GitHubClient.ts
    GitClient.ts
    BoilerplateRenderer.ts
    Telemetry.ts
    Environment.ts

  layers/             # Live implementations (the only place that imports SDKs/node APIs)
    NodeFileSystem.ts
    ChildProcessSpawner.ts
    AwsSdkClient.ts
    GitHubHttpClient.ts
    GitCliClient.ts
    WasmBoilerplate.ts
    MixpanelTelemetry.ts
    ProcessEnvironment.ts
    AppLayer.ts         # Composes all live layers into one

  domain/             # Business logic (depends only on services, never on node APIs)
    session/
    exec/
    boilerplate/
    aws/
    github/
    git/
    workspace/
    files/
    registry/

  errors/             # Typed error definitions
    index.ts          # FileNotFound, SpawnFailed, AwsAuthError, etc.

  test-utils/         # Test layers with mock implementations
    TestFileSystem.ts
    TestSpawner.ts
    TestEnvironment.ts
    TestLayer.ts        # Composes all test layers into one
```

## Service Definitions

Each service is a `Context.Tag` with a typed interface. Services define **what** can be done, not **how**.

### FileSystem

```typescript
// src/services/FileSystem.ts
import { Context, Effect, Stream } from "effect"

export interface FileSystemShape {
  readonly readFile: (path: string) => Effect.Effect<string, FileNotFoundError | FileReadError>
  readonly readFileBuffer: (path: string) => Effect.Effect<Buffer, FileNotFoundError | FileReadError>
  readonly readdir: (path: string) => Effect.Effect<string[], FileReadError>
  readonly stat: (path: string) => Effect.Effect<FileStat, FileNotFoundError>
  readonly exists: (path: string) => Effect.Effect<boolean>
  readonly writeFile: (path: string, content: string | Buffer) => Effect.Effect<void, FileWriteError>
  readonly mkdir: (path: string, options?: { recursive?: boolean }) => Effect.Effect<void, FileWriteError>
  readonly rm: (path: string, options?: { recursive?: boolean }) => Effect.Effect<void, FileWriteError>
  readonly copyFile: (src: string, dest: string) => Effect.Effect<void, FileWriteError>
  readonly mkdtemp: (prefix: string) => Effect.Effect<string, FileWriteError>
  readonly walk: (dir: string) => Stream.Stream<WalkEntry, FileReadError>
  readonly watch: (paths: string[]) => Stream.Stream<FileChangeEvent, FileWatchError>
}

export class FileSystem extends Context.Tag("FileSystem")<FileSystem, FileSystemShape>() {}
```

### ProcessSpawner

```typescript
// src/services/ProcessSpawner.ts
export interface ProcessSpawnerShape {
  readonly spawn: (command: string, args: string[], options?: SpawnOptions) => Effect.Effect<SpawnedProcess, SpawnError>
}

export interface SpawnedProcess {
  readonly output: Stream.Stream<OutputLine, never>  // merged stdout+stderr, line-by-line
  readonly exitCode: Effect.Effect<number, never>
  readonly kill: Effect.Effect<void, never>
}

export interface OutputLine {
  readonly line: string
  readonly source: "stdout" | "stderr"
}

export class ProcessSpawner extends Context.Tag("ProcessSpawner")<ProcessSpawner, ProcessSpawnerShape>() {}
```

### AwsClient

```typescript
// src/services/AwsClient.ts
export class AwsClient extends Context.Tag("AwsClient")<AwsClient, {
  readonly validateCredentials: (creds: AwsCredentials, region: string) => Effect.Effect<AwsIdentity, AwsAuthError>
  readonly listProfiles: () => Effect.Effect<ProfileInfo[], AwsConfigError>
  readonly startSsoDeviceAuth: (startUrl: string, region: string) => Effect.Effect<SsoDeviceAuth, AwsSsoError>
  readonly pollSsoToken: (params: SsoPollParams) => Effect.Effect<SsoTokenResult, AwsSsoError>
  readonly completeSsoAuth: (params: SsoCompleteParams) => Effect.Effect<AwsCredentials, AwsSsoError>
  readonly listSsoAccounts: (accessToken: string) => Effect.Effect<SsoAccount[], AwsSsoError>
  readonly listSsoRoles: (accessToken: string, accountId: string) => Effect.Effect<SsoRole[], AwsSsoError>
  readonly checkRegion: (region: string, creds: AwsCredentials) => Effect.Effect<boolean, AwsAuthError>
}>() {}
```

### GitHubClient

```typescript
// src/services/GitHubClient.ts
export class GitHubClient extends Context.Tag("GitHubClient")<GitHubClient, {
  readonly validateToken: (token: string) => Effect.Effect<GitHubUser, GitHubApiError>
  readonly startOAuthDeviceFlow: (clientId: string, scopes: string[]) => Effect.Effect<DeviceFlowStart, GitHubApiError>
  readonly pollOAuthToken: (clientId: string, deviceCode: string) => Effect.Effect<OAuthPollResult, GitHubApiError>
  readonly listOrgs: (token: string) => Effect.Effect<GitHubOrg[], GitHubApiError>
  readonly listRepos: (token: string, org: string) => Effect.Effect<GitHubRepo[], GitHubApiError>
  readonly listRefs: (token: string, owner: string, repo: string) => Effect.Effect<GitHubRef[], GitHubApiError>
  readonly listLabels: (token: string, owner: string, repo: string) => Effect.Effect<string[], GitHubApiError>
  readonly createPullRequest: (token: string, params: CreatePRParams) => Effect.Effect<PullRequestResult, GitHubApiError>
}>() {}
```

### GitClient

```typescript
// src/services/GitClient.ts
export class GitClient extends Context.Tag("GitClient")<GitClient, {
  readonly clone: (url: string, dest: string, options?: CloneOptions) => Stream.Stream<CloneProgress, GitError>
  readonly push: (repoPath: string, remote: string, branch: string, options?: PushOptions) => Effect.Effect<void, GitError>
  readonly deleteBranch: (repoPath: string, branch: string) => Effect.Effect<void, GitError>
  readonly getCurrentBranch: (repoPath: string) => Effect.Effect<string, GitError>
  readonly getRemoteUrl: (repoPath: string) => Effect.Effect<string, GitError>
  readonly diff: (repoPath: string) => Effect.Effect<DiffResult, GitError>
  readonly status: (repoPath: string) => Effect.Effect<StatusResult, GitError>
}>() {}
```

### BoilerplateRenderer

```typescript
// src/services/BoilerplateRenderer.ts
export class BoilerplateRenderer extends Context.Tag("BoilerplateRenderer")<BoilerplateRenderer, {
  readonly renderFile: (templateContent: string, variables: Record<string, unknown>) => Effect.Effect<string, RenderError>
}>() {}
```

### Telemetry

```typescript
// src/services/Telemetry.ts
export class Telemetry extends Context.Tag("Telemetry")<Telemetry, {
  readonly track: (event: string, properties?: Record<string, unknown>) => Effect.Effect<void>
}>() {}
```

### Environment

```typescript
// src/services/Environment.ts
export class Environment extends Context.Tag("Environment")<Environment, {
  readonly get: (key: string) => Effect.Effect<string | undefined>
  readonly getAll: () => Effect.Effect<Record<string, string>>
  readonly set: (key: string, value: string) => Effect.Effect<void>
  readonly delete: (key: string) => Effect.Effect<void>
  readonly snapshot: () => Effect.Effect<Record<string, string>>
}>() {}
```

## Typed Errors

All errors are tagged classes for precise `catchTag` handling.

```typescript
// src/errors/index.ts
import { Data } from "effect"

// File system
export class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{ path: string }> {}
export class FileReadError extends Data.TaggedError("FileReadError")<{ path: string; cause: unknown }> {}
export class FileWriteError extends Data.TaggedError("FileWriteError")<{ path: string; cause: unknown }> {}
export class FileWatchError extends Data.TaggedError("FileWatchError")<{ cause: unknown }> {}

// Process
export class SpawnError extends Data.TaggedError("SpawnError")<{ command: string; cause: unknown }> {}

// AWS
export class AwsAuthError extends Data.TaggedError("AwsAuthError")<{ message: string; cause?: unknown }> {}
export class AwsConfigError extends Data.TaggedError("AwsConfigError")<{ message: string }> {}
export class AwsSsoError extends Data.TaggedError("AwsSsoError")<{ message: string; cause?: unknown }> {}

// GitHub
export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{ status: number; message: string }> {}

// Git
export class GitError extends Data.TaggedError("GitError")<{ command: string; stderr: string; exitCode: number }> {}

// Boilerplate
export class RenderError extends Data.TaggedError("RenderError")<{ message: string; cause?: unknown }> {}
```

## Live Layers (Adapters)

Each layer provides a concrete implementation of a service. Layers are the **only** place that imports SDKs or Node.js APIs.

### Example: NodeFileSystem

```typescript
// src/layers/NodeFileSystem.ts
import { Layer, Effect, Stream } from "effect"
import * as fs from "fs/promises"
import chokidar from "chokidar"
import { FileSystem } from "../services/FileSystem"
import { FileNotFoundError, FileReadError } from "../errors"

export const NodeFileSystemLive = Layer.succeed(FileSystem, {
  readFile: (path) => Effect.tryPromise({
    try: () => fs.readFile(path, "utf-8"),
    catch: (e) => (e as NodeJS.ErrnoException).code === "ENOENT"
      ? new FileNotFoundError({ path })
      : new FileReadError({ path, cause: e }),
  }),
  // ... other methods
  walk: (dir) => Stream.asyncScoped(/* ... */),
  watch: (paths) => Stream.async((emit) => {
    const watcher = chokidar.watch(paths, { ignoreInitial: true })
    watcher.on("change", (path) => emit.single({ type: "change", path }))
    return Effect.addFinalizer(() => Effect.promise(() => watcher.close()))
  }),
})
```

### Example: ChildProcessSpawner

```typescript
// src/layers/ChildProcessSpawner.ts
import { Layer, Effect, Stream } from "effect"
import { spawn } from "child_process"
import { ProcessSpawner } from "../services/ProcessSpawner"

export const ChildProcessSpawnerLive = Layer.succeed(ProcessSpawner, {
  spawn: (command, args, options) => Effect.sync(() => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
    })
    return {
      output: Stream.async<OutputLine>((emit) => {
        proc.stdout?.on("data", (chunk) => { /* parse lines, emit */ })
        proc.stderr?.on("data", (chunk) => { /* parse lines, emit */ })
        proc.on("close", () => emit.end())
      }),
      exitCode: Effect.promise(() => new Promise((resolve) => proc.on("close", resolve))),
      kill: Effect.sync(() => proc.kill()),
    }
  }),
})
```

### Example: GitCliClient (depends on ProcessSpawner)

```typescript
// src/layers/GitCliClient.ts
import { Layer, Effect, Stream } from "effect"
import { GitClient } from "../services/GitClient"
import { ProcessSpawner } from "../services/ProcessSpawner"

// Layer that requires ProcessSpawner to build GitClient
export const GitCliClientLive = Layer.effect(
  GitClient,
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    return {
      clone: (url, dest, options) => Stream.unwrap(
        Effect.gen(function* () {
          const proc = yield* spawner.spawn("git", ["clone", "--progress", url, dest])
          return proc.output  // Stream of progress lines
        })
      ),
      getCurrentBranch: (repoPath) => Effect.gen(function* () {
        const proc = yield* spawner.spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath })
        // collect output, return trimmed string
      }),
      // ...
    }
  })
)
```

### App Layer (Composition)

```typescript
// src/layers/AppLayer.ts
import { Layer } from "effect"

// Layers with no dependencies
const BaseLive = Layer.mergeAll(
  NodeFileSystemLive,
  ChildProcessSpawnerLive,
  ProcessEnvironmentLive,
  AwsSdkClientLive,
  GitHubHttpClientLive,
  WasmBoilerplateLive,
  MixpanelTelemetryLive,
)

// Layers that depend on other layers
const GitLive = GitCliClientLive  // requires ProcessSpawner

// Full application layer
export const AppLive = BaseLive.pipe(
  Layer.provideMerge(GitLive),
)
// Type: Layer<FileSystem | ProcessSpawner | Environment | AwsClient | GitHubClient | GitClient | BoilerplateRenderer | Telemetry>
```

## Domain Modules

Domain modules use `Effect.gen` with `yield*` to access services. They never import adapters or Node.js APIs.

```typescript
// src/domain/exec/executor.ts
import { Effect, Stream } from "effect"
import { FileSystem } from "../../services/FileSystem"
import { ProcessSpawner } from "../../services/ProcessSpawner"
import { Environment } from "../../services/Environment"

export const executeScript = (request: ExecRequest) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const spawner = yield* ProcessSpawner
    const env = yield* Environment

    // Create temp files (cleanup guaranteed by Scope)
    const outputFile = yield* fs.mkdtemp("runbook-output-")
    yield* Effect.addFinalizer(() => fs.rm(outputFile, { recursive: true }))

    const envSnapshot = yield* env.snapshot()
    const proc = yield* spawner.spawn(request.interpreter, request.args, {
      cwd: request.workingDir,
      env: { ...envSnapshot, RUNBOOK_OUTPUT: outputFile },
    })

    // Return stream of execution events
    return proc.output.pipe(
      Stream.map((line) => ({ type: "log" as const, ...line })),
    )
  })
```

## Composition Root

### Electron Main Process

Use `ManagedRuntime` to bridge Effect with Electron's IPC handlers.

```typescript
// electron/main/index.ts
import { ManagedRuntime } from "effect"
import { AppLive } from "../../src/layers/AppLayer"

// Create runtime from full layer — compiler verifies all services are provided
const runtime = ManagedRuntime.make(AppLive)

// IPC handler bridges Effect to Electron
ipcMain.handle("exec:run", async (event, request) => {
  return runtime.runPromise(
    executeScript(request).pipe(
      // Convert stream events to IPC sends
      Stream.runForEach((ev) =>
        Effect.sync(() => event.sender.send("exec:log", ev))
      )
    )
  )
})

// Cleanup on app quit
app.on("will-quit", () => runtime.dispose())
```

### CLI Test Runner

Same layer, no Electron:

```typescript
// cli/index.ts
import { ManagedRuntime } from "effect"
import { AppLive } from "../src/layers/AppLayer"

const runtime = ManagedRuntime.make(AppLive)
// Test executor uses runtime.runPromise() to run effects
```

## Testing

Swap layers to provide mock implementations. The compiler ensures all services are satisfied.

### Test Layers

```typescript
// src/test-utils/TestFileSystem.ts
import { Layer } from "effect"
import { FileSystem } from "../services/FileSystem"

export const makeTestFileSystem = (files: Record<string, string>) =>
  Layer.succeed(FileSystem, {
    readFile: (path) =>
      path in files
        ? Effect.succeed(files[path])
        : Effect.fail(new FileNotFoundError({ path })),
    exists: (path) => Effect.succeed(path in files),
    writeFile: (path, content) => Effect.sync(() => { files[path] = String(content) }),
    // ... in-memory implementations for all methods
  })
```

```typescript
// src/test-utils/TestSpawner.ts
export const makeTestSpawner = (expectations: SpawnExpectation[]) =>
  Layer.succeed(ProcessSpawner, {
    spawn: (command, args) => {
      const match = expectations.find(e => e.command === command)
      if (!match) return Effect.fail(new SpawnError({ command, cause: "unexpected command" }))
      return Effect.succeed({
        output: Stream.fromIterable(match.outputLines.map(line => ({ line, source: "stdout" as const }))),
        exitCode: Effect.succeed(match.exitCode),
        kill: Effect.void,
      })
    }
  })
```

```typescript
// src/test-utils/TestLayer.ts
// Compose all test layers for a fully-mocked environment
export const makeTestLayer = (options: TestLayerOptions) =>
  Layer.mergeAll(
    makeTestFileSystem(options.files ?? {}),
    makeTestSpawner(options.commands ?? []),
    makeTestEnvironment(options.env ?? {}),
    makeTestAwsClient(options.aws),
    makeTestGitHubClient(options.github),
    makeTestGitClient(options.git),
    makeTestBoilerplate(options.boilerplate),
    makeTestTelemetry(),
  )
```

### Using in Tests

```typescript
// In any test file
import { Effect } from "effect"
import { makeTestLayer } from "../test-utils/TestLayer"
import { executeScript } from "../domain/exec/executor"

test("executeScript runs command and captures output", async () => {
  const TestLayer = makeTestLayer({
    files: { "/runbook/script.sh": "echo hello" },
    commands: [{ command: "/bin/bash", outputLines: ["hello"], exitCode: 0 }],
    env: { HOME: "/home/test" },
  })

  const result = await Effect.runPromise(
    executeScript(request).pipe(
      Stream.runCollect,  // collect all stream events
      Effect.provide(TestLayer),
    )
  )

  expect(result).toContainEqual({ type: "log", line: "hello", source: "stdout" })
})
```

No real filesystem, no real processes, no real AWS. The compiler guarantees all 8 services are provided — if you forget one, it's a type error.

## Frontend DI (Context-Based)

The frontend doesn't use Effect directly. It wraps `window.api` in a React context for test swapping.

```typescript
// web/src/contexts/ApiContext.tsx
import { createContext, useContext } from 'react'

export type RunbooksAPI = typeof window.api

const ApiContext = createContext<RunbooksAPI>(null!)

export function ApiProvider({ api, children }: { api: RunbooksAPI; children: React.ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
}

export function useApi(): RunbooksAPI {
  return useContext(ApiContext)
}
```

All hooks use `useApi()` instead of `window.api` directly. Tests provide `createMockApi()`:

```typescript
render(
  <ApiProvider api={createMockApi({ "runbook:get": { content: "# Test" } })}>
    <MyComponent />
  </ApiProvider>
)
```

## Rules

1. **No `src/domain/` module imports Node.js APIs or SDKs** — only Effect services via `yield*`. No `import fs from 'fs'`, no `import { STSClient }`.
2. **No `src/domain/` module imports `electron`** — the Electron dependency stays in `electron/`.
3. **All external operations return `Effect<A, E, R>`** — never raw Promises in domain code.
4. **Errors are always typed** — every `Effect.fail` uses a `Data.TaggedError` subclass, never a plain string or `Error`.
5. **Layers have no business logic** — adapters only translate between service interfaces and external APIs.
6. **`src/layers/` is the only directory that imports external packages** (AWS SDK, chokidar, etc.).
7. **Resource cleanup uses Scope** — temp files, watchers, WASM instances use `acquireRelease` or `addFinalizer`.
8. **Frontend uses `useApi()` context** — never `window.api` directly.
9. **Tests never need real external services** — swap Layers, not implementations.
