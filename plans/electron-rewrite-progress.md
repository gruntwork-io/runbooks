# Electron Rewrite Progress

Tracks implementation progress for the Electron migration. Updated as work proceeds.

## Phase 1: Scaffold ✅
- [x] `.mise.toml` — tool versioning (Node 24, bun 1.3)
- [x] `justfile` — command runner replacing Taskfile.yml (uses `mise x` pattern)
- [x] `electron.vite.config.ts` — 3 entry points (main, preload, renderer)
- [x] `electron-builder` config in package.json
- [x] `electron/main/index.ts` — app entry, window creation, native IPC handlers
- [x] `electron/preload/index.ts` — contextBridge exposing typed window.api
- [x] `electron/shared/channels.ts` — IPC channel constants + types (full API)
- [x] `oxlintrc.json` — linter config (oxfmt placeholder in justfile)
- [x] Root `package.json` — restructured with Electron 41.1.1 deps
- [x] Root `tsconfig.json` files — main, preload, src, web references
- [x] `electron-vite build` succeeds (main, preload, renderer all compile)

## Phase 2: Backend Modules (`src/`) ✅
- [x] `src/errors/index.ts` — 18 typed error classes (Data.TaggedError)
- [x] `src/services/` — all 8 Effect service definitions
- [x] `src/types.ts` — all shared TypeScript interfaces + constants
- [x] `src/path-validation.ts` — path security checks
- [x] `src/mdx.ts` — MDX fence detection
- [x] `src/domain/session/manager.ts` — session management (multi-token, env capture)
- [x] `src/domain/exec/executor.ts` — script execution orchestration (streaming, timeout)
- [x] `src/domain/exec/script.ts` — script preparation (interpreter detection, bash wrapping)
- [x] `src/domain/workspace/file.ts` — file reading, language detection
- [x] `src/domain/workspace/file-tree.ts` — directory tree building
- [x] `src/domain/workspace/workspace.ts` — workspace ops (gitignore, lazy-load, diffs)
- [x] `src/domain/files/manifest.ts` — file manifest tracking (SHA-256, diff)
- [x] `src/domain/files/generated.ts` — generated files management
- [x] `src/domain/boilerplate/config.ts` — YAML config parsing (reimplemented in TS)
- [x] `src/domain/aws/auth.ts` — AWS auth (delegates to AwsClient service)
- [x] `src/domain/github/auth.ts` — GitHub auth + OAuth device flow
- [x] `src/domain/git/operations.ts` — clone, push, PR creation, branch ops
- [x] `src/domain/registry/executable.ts` — executable registry (MDX parsing)
- [x] `src/watcher.ts` — file watching (debounced, via FileSystem service)
- [x] `src/remote-source.ts` — remote URL parsing (7 formats)
- [x] `src/telemetry.ts` — Mixpanel telemetry (singleton)
- [x] `src/layers/` — all 9 live layers (NodeFileSystem, ChildProcessSpawner, ProcessEnvironment, AwsSdkClient, GitHubHttpClient, GitCliClient, WasmBoilerplate, MixpanelTelemetry, AppLayer)
- [x] `src/test-utils/` — all 4 test layer files (TestFileSystem, TestSpawner, TestEnvironment, TestLayer)

## Phase 3: IPC Layer ✅
- [x] `electron/main/ipc/runtime.ts` — ManagedRuntime + shared state
- [x] `electron/main/ipc/session.ts` — 6 session handlers
- [x] `electron/main/ipc/runbook.ts` — 3 runbook handlers
- [x] `electron/main/ipc/exec.ts` — streaming exec handler
- [x] `electron/main/ipc/boilerplate.ts` — 3 boilerplate handlers
- [x] `electron/main/ipc/aws.ts` — 10 AWS auth handlers
- [x] `electron/main/ipc/github.ts` — 9 GitHub handlers
- [x] `electron/main/ipc/git.ts` — 4 git handlers (streaming clone/push)
- [x] `electron/main/ipc/workspace.ts` — 6 workspace handlers
- [x] `electron/main/ipc/files.ts` — 3 file handlers
- [x] `electron/main/ipc/watch.ts` — watch mode streaming handler
- [x] `electron/main/ipc/telemetry.ts` — telemetry config handler
- [x] `electron/main/ipc/index.ts` — registers all handlers

## Phase 4: Frontend Migration ✅
- [x] `web/src/api.d.ts` — window.api type declarations
- [x] `web/src/contexts/ApiContext.tsx` — DI provider (useApi hook)
- [x] `web/src/hooks/useIpc.ts` — base IPC hook (replaces useApi)
- [x] `web/src/hooks/useIpcExec.ts` — exec streaming (replaces useApiExec)
- [x] `web/src/hooks/useIpcGetRunbook.ts` — runbook get
- [x] `web/src/hooks/useIpcGetFile.ts` — file read
- [x] `web/src/hooks/useIpcGetBoilerplateConfig.ts` — boilerplate config
- [x] `web/src/hooks/useIpcBoilerplateRender.ts` — boilerplate render
- [x] `web/src/hooks/useIpcGeneratedFilesCheck.ts` — generated files check
- [x] `web/src/hooks/useIpcGeneratedFilesDelete.ts` — generated files delete
- [x] `web/src/hooks/useIpcExecutableRegistry.ts` — executable registry
- [x] `web/src/hooks/useIpcFileContent.ts` — file content with LRU cache
- [x] `web/src/hooks/useIpcGitFileChanges.ts` — git changes polling
- [x] `web/src/hooks/useIpcGitFileTree.ts` — git file tree with lazy-load
- [x] `web/src/hooks/useIpcWatchMode.ts` — watch mode events
- [x] `web/src/contexts/IpcSessionContext.tsx` — session (no Bearer tokens)
- [x] `web/src/contexts/IpcExecutableRegistryContext.tsx` — registry via IPC
- [x] `web/src/contexts/IpcGitWorkTreeContext.tsx` — worktree via IPC
- [x] `web/src/contexts/IpcTelemetryContext.tsx` — telemetry via IPC
- [x] `web/src/test-utils/mock-api.ts` — mock IPC for component tests

## Phase 5: Electron Main Process ✅
- [x] `electron/main/window.ts` — BrowserWindow lifecycle
- [x] `electron/main/menu.ts` — native app menu
- [x] `electron/main/updater.ts` — auto-update via electron-updater
- [x] `electron/main/cli.ts` — CLI arg parsing
- [x] `electron/main/index.ts` — updated with single-instance lock, macOS open-file, runtime cleanup

## Phase 6: CLI Test Runner
- [ ] `cli/index.ts` — commander.js entry
- [ ] `cli/commands/test.ts` — test command
- [ ] `cli/test/` — executor, config, assertions, reporter

## Phase 7: Build & Distribution
- [ ] electron-builder configs (macOS DMG, Linux AppImage/deb, Windows NSIS)
- [ ] Code signing for macOS
- [ ] Auto-update via electron-updater

## Phase 8: Documentation
- [ ] README.md, AGENTS.md updates
- [ ] Docs site updates (~28 files)

## Phase 9: Cleanup
- [ ] Remove Go files (api/, cmd/, browser/, templates/, main.go, go.mod, go.sum)
- [ ] Remove ESLint config + deps
- [ ] Remove Taskfile.yml
- [ ] Update CI/CD

---

## Current Status

**Completed**: Phases 1–5 (Scaffold, Backend, IPC, Frontend, Main Process)
**Remaining**: Phases 6–9 (CLI Test Runner, Build & Distribution, Documentation, Cleanup)
**Last updated**: 2026-04-04

## File Count

| Directory | Files | Description |
|-----------|-------|-------------|
| `electron/main/` | 5 | App entry, window, menu, updater, CLI |
| `electron/main/ipc/` | 13 | IPC handler modules |
| `electron/preload/` | 1 | Context bridge |
| `electron/shared/` | 1 | IPC channel types |
| `src/errors/` | 1 | Typed errors |
| `src/services/` | 8 | Effect service definitions |
| `src/layers/` | 9 | Live implementations |
| `src/domain/` | 13 | Business logic modules |
| `src/test-utils/` | 4 | Test layers |
| `src/` (root) | 6 | types, path-validation, mdx, remote-source, telemetry, watcher |
| `web/src/hooks/` (new) | 15 | IPC-based hooks |
| `web/src/contexts/` (new) | 6 | IPC-based contexts + ApiContext |
| `web/src/test-utils/` | 1 | Mock IPC API |
| Root configs | 6 | package.json, tsconfigs, justfile, mise, electron.vite, oxlint |
| **Total new files** | **~89** | |
