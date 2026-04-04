# Electron Rewrite Plan

Full rewrite from Go backend + browser frontend to Electron app with Node.js backend using IPC.

## Decisions

- **Tooling**: VoidZero stack (Vite, Vitest, oxlint, oxfmt) + mise (tool versions) + just (command runner). See [electron-rewrite-tooling.md](./electron-rewrite-tooling.md)
- **Backend**: Full Node.js rewrite (no Go sidecar)
- **Boilerplate rendering**: WASM binary from [boilerplate releases](https://github.com/gruntwork-io/boilerplate/releases) (brotli-compressed)
- **Boilerplate config parsing**: Reimplement in TypeScript (parse YAML, extract variables/types/validations/sections)
- **TF/HCL parsing**: Dropped (see [electron-rewrite-dropped.md](./electron-rewrite-dropped.md))
- **Distribution**: Electron only, no standalone Go binary
- **Test runner**: Separate Node.js CLI binary sharing `src/` modules
- **Frontend-backend communication**: Electron IPC (not HTTP)
- **Platforms**: macOS arm64+x64, Linux x64, Windows x64
- **Abstraction boundaries**: Effect services + layers for DI, typed errors, resource safety. See [electron-rewrite-di.md](./electron-rewrite-di.md)

## Architecture

See [electron-rewrite-backend.md](./electron-rewrite-backend.md) for the full Go-to-TypeScript module mapping.

```
runbooks/
  electron/
    main/index.ts           # App entry, window creation, IPC registration
    main/window.ts          # BrowserWindow lifecycle
    main/menu.ts            # Native app menu
    main/updater.ts         # Auto-update (electron-updater)
    main/cli.ts             # CLI arg parsing (open, watch)
    main/ipc/               # IPC handlers (thin wrappers over src/)
    preload/index.ts        # contextBridge exposing typed window.api
    shared/channels.ts      # IPC channel constants + types

  src/                      # Core backend (shared by Electron + CLI), built on Effect
    services/               # Effect service definitions (Context.Tag + interface)
      FileSystem.ts         # FileSystem service tag
      ProcessSpawner.ts     # ProcessSpawner service tag
      AwsClient.ts          # AwsClient service tag
      GitHubClient.ts       # GitHubClient service tag
      GitClient.ts          # GitClient service tag
      BoilerplateRenderer.ts # BoilerplateRenderer service tag
      Telemetry.ts          # Telemetry service tag
      Environment.ts        # Environment service tag
    layers/                 # Live implementations (only place that imports SDKs/node APIs)
      NodeFileSystem.ts     # fs/promises, chokidar
      ChildProcessSpawner.ts # child_process.spawn
      AwsSdkClient.ts       # @aws-sdk/* v3
      GitHubHttpClient.ts   # fetch to api.github.com
      GitCliClient.ts       # ProcessSpawner + git CLI (Layer depends on ProcessSpawner)
      WasmBoilerplate.ts    # WebAssembly boilerplate binary
      MixpanelTelemetry.ts  # Mixpanel Node SDK
      ProcessEnvironment.ts # process.env
      AppLayer.ts           # Composes all live layers into one
    domain/                 # Business logic (uses services via yield*, never imports node APIs)
      session/              # yield* Environment
      exec/                 # yield* FileSystem, ProcessSpawner, Environment
      boilerplate/          # yield* FileSystem, BoilerplateRenderer
      aws/                  # yield* AwsClient, FileSystem, Environment
      github/               # yield* GitHubClient, ProcessSpawner, Environment
      git/                  # yield* GitClient
      workspace/            # yield* FileSystem
      files/                # yield* FileSystem
      registry/             # yield* FileSystem
    errors/                 # Typed error classes (Data.TaggedError)
    test-utils/             # Test layers with mock implementations for all services
    types.ts                # Shared TypeScript interfaces

  cli/                      # Node.js CLI (test runner)
    index.ts                # commander.js entry
    commands/test.ts        # Test command
    test/executor.ts        # Test execution engine
    test/config.ts          # YAML config parsing
    test/assertions.ts      # Assertion helpers
    test/reporter.ts        # Text/JUnit output

  web/                      # Existing React frontend (updated for IPC)
    src/api.d.ts            # window.api type declarations
    src/contexts/ApiContext.tsx # DI provider: wraps window.api, swappable in tests
    src/hooks/              # Rewritten: fetch+SSE -> IPC via useApi() context
    src/contexts/           # Updated for IPC
    src/components/         # Mostly unchanged
    src/test-utils/mock-api.ts # Mock IPC API for component tests
```

## Phases

### 1. Scaffold
- `.mise.toml` for tool versioning (Node.js, bun)
- `justfile` replacing `Taskfile.yml` (dev, build, test, lint, fmt recipes)
- Electron + TypeScript project setup with `electron-vite`
- electron-builder config for packaging
- `electron.vite.config.ts` with 3 entry points (main, preload, renderer)
- Replace ESLint with oxlint, add oxfmt
- Shared IPC types in `electron/shared/channels.ts`
- Verify BrowserWindow loads React app

### 2. Backend Modules (`src/`)
First: define Effect services in `src/services/`, typed errors in `src/errors/`, and test layers in `src/test-utils/`. See [electron-rewrite-di.md](./electron-rewrite-di.md).
Then: implement live layers in `src/layers/` and domain modules in `src/domain/`. See [electron-rewrite-backend.md](./electron-rewrite-backend.md) for the Go-to-TypeScript mapping.
Rule: domain modules use `yield* ServiceTag` to access dependencies — never import Node.js APIs or SDKs directly.

### 3. IPC Layer
Wire `src/` modules to Electron IPC - see [electron-rewrite-ipc.md](./electron-rewrite-ipc.md) for the complete IPC API specification.

### 4. Frontend Migration
Rewrite hooks/contexts from fetch+SSE to IPC - see [electron-rewrite-frontend.md](./electron-rewrite-frontend.md) for file-by-file changes.

### 5. Electron Main Process
- App lifecycle, native menu, auto-update
- CLI argument parsing for `open` and `watch` commands
- Native file dialogs, shell.openExternal for OAuth

### 6. CLI Test Runner
- Port `api/testing/` to `cli/test/`
- Reuses `src/` modules directly (no IPC, no Electron)
- Build as standalone binary via `bun compile`

### 7. Build & Distribution
- electron-builder: macOS DMG, Linux AppImage/deb, Windows NSIS
- Code signing for macOS
- Auto-update via electron-updater

### 8. Documentation
Rewrite all docs that reference Go, HTTP server, CLI commands, or build process. See [electron-rewrite-docs.md](./electron-rewrite-docs.md) for the full file-by-file plan (~28 files, prioritized).

### 9. Cleanup
- Remove Go: `api/`, `cmd/`, `browser/`, `templates/`, `main.go`, `go.mod`, `go.sum`, `web/embed.go`
- Remove ESLint: `eslint.config.js`, `eslint`/`@eslint/js`/`typescript-eslint`/plugin deps
- Remove `Taskfile.yml` (replaced by `justfile`)
- Delete `docs/authoring/blocks/TfModule.mdx`, `docs/commands/serve.mdx`
- Update CI/CD

## Key Patterns

### IPC Streaming (replaces SSE)
Long-running operations stream events via IPC instead of SSE:
- Main process: `event.sender.send('exec:log', data)` during execution
- Renderer: `window.api.exec.onLog(callback)` to subscribe
- Result: `await window.api.exec.run(req)` resolves when done
- Cleanup: `window.api.exec.offLog(callback)` on unmount

### Boilerplate WASM
- Downloaded at build time from boilerplate GitHub releases
- Loaded via `WebAssembly.instantiate()` in main process
- Renders individual template files in-memory
- Config parsing is pure TypeScript (YAML + variable type extraction)

### Node.js Equivalents
| Go | Node.js |
|----|---------|
| `creack/pty` | Dropped (pipes only, see [dropped.md](./electron-rewrite-dropped.md)) |
| `gin-gonic/gin` | Electron IPC handlers |
| `aws-sdk-go-v2` | `@aws-sdk/*` v3 |
| `hashicorp/hcl/v2` | Dropped (TfModule feature removed) |
| `gruntwork-io/boilerplate` render | Boilerplate WASM binary |
| `gruntwork-io/boilerplate` config | Custom YAML parser (TypeScript) |
| `fsnotify/fsnotify` | `chokidar` |
| `spf13/cobra` | `commander` |
| `gopkg.in/yaml.v3` | `yaml` (npm) |

## Verification

1. All existing Playwright E2E tests pass against Electron
2. All existing Vitest unit tests pass
3. `runbooks test testdata/` passes via CLI test runner
4. Manual test of every MDX block type
5. Build succeeds for macOS, Linux, Windows
6. Watch mode triggers reload on file changes
