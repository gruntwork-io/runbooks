# Monorepo Implementation Notes

Prepared workspace configs for the Bun workspaces migration described in `plans/monorepo.md`.
This document covers what was created, what still needs to change, and the exact steps to execute.

## What was created (Phase 1 prep)

### Workspace package.json files

1. **`packages/core/package.json`** (`@runbooks/core`)
   - Owns: effect, chokidar, yaml, ini, all @aws-sdk/* clients, mixpanel
   - These are currently in root package.json dependencies

2. **`packages/shared/package.json`** (`@runbooks/shared`)
   - No runtime dependencies (types-only package)
   - Contains only `channels.ts` which defines IPC channel types

3. **`cli/package.json`** (`@runbooks/cli`)
   - Owns: commander, yaml, effect
   - Depends on `@runbooks/core` via `workspace:*`
   - Note: yaml is needed directly by `cli/test/config.ts` and `cli/test/validation.ts`
   - Note: effect is needed directly by `cli/test/executor.ts` (ManagedRuntime)

### Workspace tsconfig.json files

4. **`packages/core/tsconfig.json`** - includes all `src/**/*` patterns (domain, services, layers, etc.)
5. **`packages/shared/tsconfig.json`** - includes only `channels.ts`
6. **`cli/tsconfig.json`** - includes cli source, with path alias for `@runbooks/core/*`

All tsconfig files use the same compiler options as the existing `tsconfig.src.json`.

## Root package.json changes needed

Add workspaces field:
```json
{
  "workspaces": ["packages/*", "web", "cli", "docs"]
}
```

After file moves complete, update dependencies:
- **Remove** from root deps (moved to @runbooks/core): effect, chokidar, yaml, ini, all @aws-sdk/*, mixpanel
- **Remove** from root deps (moved to @runbooks/cli): commander
- **Add** to root deps: `"@runbooks/core": "workspace:*"`, `"@runbooks/shared": "workspace:*"`
- **Keep** in root deps: electron-updater (used by electron/main), all React/Radix/UI deps (used by web/ renderer built from root context)
- **Keep** in root devDeps: electron, electron-builder, electron-vite, vite, vitest, typescript, playwright, testing-library

Note: `zod` stays in root because it is used by web/ (which is built as part of the electron-vite renderer), not by packages/core.

## Root tsconfig.json changes needed

Current root `tsconfig.json`:
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.main.json" },
    { "path": "./tsconfig.preload.json" },
    { "path": "./tsconfig.src.json" },
    { "path": "./web/tsconfig.json" }
  ]
}
```

After migration:
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.main.json" },
    { "path": "./tsconfig.preload.json" },
    { "path": "./packages/core/tsconfig.json" },
    { "path": "./packages/shared/tsconfig.json" },
    { "path": "./cli/tsconfig.json" },
    { "path": "./web/tsconfig.json" }
  ]
}
```

Delete `tsconfig.src.json` (replaced by `packages/core/tsconfig.json` + `cli/tsconfig.json`).

## tsconfig.main.json changes needed

Current includes: `["electron/main/**/*", "electron/shared/**/*"]`

After migration (electron/shared/ moves to packages/shared/):
```json
{
  "include": ["electron/main/**/*"]
}
```

electron/main/ will import from `@runbooks/core` and `@runbooks/shared` instead of relative paths. TypeScript resolves these via Bun workspace symlinks in `node_modules/@runbooks/`. No path aliases needed in tsconfig since Bun symlinks handle it.

## electron.vite.config.ts changes needed

```ts
main: {
  plugins: [externalizeDepsPlugin({
    exclude: ["electron-updater", "@runbooks/core", "@runbooks/shared"],
  })],
  resolve: {
    alias: {
      "@runbooks/core": path.resolve(__dirname, "packages/core"),
      "@runbooks/shared": path.resolve(__dirname, "packages/shared"),
    },
  },
  // ... existing build config
}
```

The aliases ensure electron-vite/Rollup can resolve workspace packages during bundling.
The `exclude` in externalizeDepsPlugin ensures @runbooks/* code is inlined into the bundle
(the packaged Electron app won't have node_modules/@runbooks/).

## vitest.config.ts changes needed

```ts
include: [
  "packages/core/**/*.test.ts",
  "electron/**/*.test.ts",
],
coverage: {
  include: ["packages/core/**/*.ts", "electron/**/*.ts"],
}
```

## File moves (Phase 2-3)

### Phase 2: src/ -> packages/core/

```bash
git mv src/* packages/core/
```

This moves all of:
- domain/ (aws, boilerplate, exec, files, git, github, registry, session, workspace)
- errors/
- layers/ (AppLayer, AwsSdkClient, ChildProcessSpawner, GitCliClient, GitHubHttpClient, MixpanelTelemetry, NodeFileSystem, ProcessEnvironment, WasmBoilerplate)
- services/ (AwsClient, BoilerplateRenderer, Environment, FileSystem, GitClient, GitHubClient, ProcessSpawner, Telemetry)
- test-utils/ (TestEnvironment, TestFileSystem, TestLayer, TestSpawner)
- types.ts, mdx.ts, mdx.test.ts, telemetry.ts, watcher.ts
- path-validation.ts, path-validation.test.ts
- remote-source.ts, remote-source.test.ts

### Phase 3: electron/shared/ -> packages/shared/

```bash
git mv electron/shared/channels.ts packages/shared/channels.ts
rmdir electron/shared
```

## Import rewrites needed (Phase 4-6)

### electron/main/ imports (44 imports across 13 files)

All `../../../src/...` and `../../src/...` patterns become `@runbooks/core/...`:

| File | Current import | New import |
|------|---------------|------------|
| `electron/main/ipc/files.ts` | `../../../src/domain/workspace/file.ts` | `@runbooks/core/domain/workspace/file` |
| `electron/main/ipc/files.ts` | `../../../src/domain/files/generated.ts` | `@runbooks/core/domain/files/generated` |
| `electron/main/ipc/files.ts` | `../../../src/path-validation.ts` | `@runbooks/core/path-validation` |
| `electron/main/ipc/git.ts` | `../../../src/domain/git/operations.ts` | `@runbooks/core/domain/git/operations` |
| `electron/main/ipc/git.ts` | `../../../src/services/GitClient.ts` | `@runbooks/core/services/GitClient` |
| `electron/main/ipc/git.ts` | `../../../src/path-validation.ts` | `@runbooks/core/path-validation` |
| `electron/main/ipc/git.ts` | `../../../src/errors/index.ts` | `@runbooks/core/errors/index` |
| `electron/main/ipc/boilerplate.ts` | `../../../src/domain/boilerplate/config.ts` | `@runbooks/core/domain/boilerplate/config` |
| `electron/main/ipc/boilerplate.ts` | `../../../src/services/BoilerplateRenderer.ts` | `@runbooks/core/services/BoilerplateRenderer` |
| `electron/main/ipc/boilerplate.ts` | `../../../src/services/FileSystem.ts` | `@runbooks/core/services/FileSystem` |
| `electron/main/ipc/boilerplate.ts` | `../../../src/domain/workspace/file-tree.ts` | `@runbooks/core/domain/workspace/file-tree` |
| `electron/main/ipc/boilerplate.ts` | `../../../src/domain/files/manifest.ts` | `@runbooks/core/domain/files/manifest` |
| `electron/main/ipc/boilerplate.ts` | `../../../src/domain/files/generated.ts` | `@runbooks/core/domain/files/generated` |
| `electron/main/ipc/boilerplate.ts` | `../../../src/types.ts` | `@runbooks/core/types` |
| `electron/main/ipc/exec.ts` | `../../../src/domain/exec/executor.ts` | `@runbooks/core/domain/exec/executor` |
| `electron/main/ipc/exec.ts` | `../../../src/domain/session/manager.ts` | `@runbooks/core/domain/session/manager` |
| `electron/main/ipc/exec.ts` | `../../../src/types.ts` | `@runbooks/core/types` |
| `electron/main/ipc/path-guard.ts` | `../../../src/path-validation.ts` | `@runbooks/core/path-validation` |
| `electron/main/ipc/path-guard.ts` | `../../../src/errors/index.ts` | `@runbooks/core/errors/index` |
| `electron/main/ipc/telemetry.ts` | `../../../src/telemetry.ts` | `@runbooks/core/telemetry` |
| `electron/main/ipc/runtime.ts` | `../../../src/layers/AppLayer.ts` | `@runbooks/core/layers/AppLayer` |
| `electron/main/ipc/runtime.ts` | `../../../src/domain/session/manager.ts` | `@runbooks/core/domain/session/manager` |
| `electron/main/ipc/runtime.ts` | `../../../src/domain/registry/executable.ts` | `@runbooks/core/domain/registry/executable` |
| `electron/main/ipc/runtime.ts` | `../../../src/domain/files/manifest.ts` | `@runbooks/core/domain/files/manifest` |
| `electron/main/ipc/runtime.ts` | `../../../src/types.ts` | `@runbooks/core/types` |
| `electron/main/ipc/runtime.ts` | `../../../src/services/FileSystem.ts` | `@runbooks/core/services/FileSystem` |
| `electron/main/ipc/runtime.ts` | `../../../src/errors/index.ts` | `@runbooks/core/errors/index` |
| `electron/main/ipc/aws.ts` | `../../../src/domain/aws/auth.ts` | `@runbooks/core/domain/aws/auth` |
| `electron/main/ipc/aws.ts` | `../../../src/services/AwsClient.ts` | `@runbooks/core/services/AwsClient` |
| `electron/main/ipc/watch.ts` | `../../../src/watcher.ts` | `@runbooks/core/watcher` |
| `electron/main/ipc/watch.ts` | `../../../src/domain/registry/executable.ts` | `@runbooks/core/domain/registry/executable` |
| `electron/main/ipc/workspace.ts` | `../../../src/domain/workspace/workspace.ts` | `@runbooks/core/domain/workspace/workspace` |
| `electron/main/ipc/workspace.ts` | `../../../src/path-validation.ts` | `@runbooks/core/path-validation` |
| `electron/main/ipc/runbook.ts` | `../../../src/domain/registry/executable.ts` | `@runbooks/core/domain/registry/executable` |
| `electron/main/ipc/runbook.ts` | `../../../src/domain/workspace/file.ts` | `@runbooks/core/domain/workspace/file` |
| `electron/main/ipc/runbook.ts` | `../../../src/path-validation.ts` | `@runbooks/core/path-validation` |
| `electron/main/ipc/runbook.ts` | `../../../src/services/FileSystem.ts` | `@runbooks/core/services/FileSystem` |
| `electron/main/ipc/runbook.ts` | `../../../src/types.ts` | `@runbooks/core/types` |
| `electron/main/ipc/github.ts` | `../../../src/domain/github/auth.ts` | `@runbooks/core/domain/github/auth` |
| `electron/main/remote.ts` | `../../src/remote-source.ts` | `@runbooks/core/remote-source` |
| `electron/main/remote.ts` | `../../src/domain/workspace/file.ts` | `@runbooks/core/domain/workspace/file` |
| `electron/main/remote.ts` | `../../src/services/GitClient.ts` | `@runbooks/core/services/GitClient` |

### electron/preload/ imports (1 file)

| File | Current import | New import |
|------|---------------|------------|
| `electron/preload/index.ts` | `../shared/channels.ts` | `@runbooks/shared/channels` |

### cli/ imports (8 imports across 2 files)

| File | Current import | New import |
|------|---------------|------------|
| `cli/test/executor.ts` | `../../src/domain/registry/executable.ts` | `@runbooks/core/domain/registry/executable` |
| `cli/test/executor.ts` | `../../src/layers/NodeFileSystem.ts` | `@runbooks/core/layers/NodeFileSystem` |
| `cli/test/executor.ts` | `../../src/domain/exec/script.ts` | `@runbooks/core/domain/exec/script` |
| `cli/test/executor.ts` | `../../src/types.ts` | `@runbooks/core/types` |
| `cli/test/executor.ts` | `../../src/domain/registry/executable.ts` (type) | `@runbooks/core/domain/registry/executable` |
| `cli/test/validation.ts` | `../../src/domain/registry/executable.ts` | `@runbooks/core/domain/registry/executable` |
| `cli/test/validation.ts` | `../../src/mdx.ts` | `@runbooks/core/mdx` |

### web/ imports (1 file)

| File | Current import | New import |
|------|---------------|------------|
| `web/src/api.d.ts` | `../../electron/shared/channels.ts` | `@runbooks/shared/channels` |

Also add `"@runbooks/shared": "workspace:*"` to `web/package.json` dependencies.

## Import rewrite note: .ts extensions

Current imports use `.ts` extensions (e.g., `from "../../src/types.ts"`).
The new package imports should drop the `.ts` extension since they go through workspace resolution:
`from "@runbooks/core/types"` (not `@runbooks/core/types.ts`).

However, check if `allowImportingTsExtensions` is in play. Since all tsconfigs use `allowImportingTsExtensions: true` and `noEmit: true`, both forms work. For consistency with standard package import conventions, the new imports should omit the extension. But if the codebase uses `.ts` extensions pervasively in internal imports (within packages/core itself), it is fine to keep `.ts` on the workspace package imports too. Either way works with `moduleResolution: "bundler"`.

## Lockfile cleanup

Delete these files in Phase 1 (before `bun install`):
- `web/bun.lock` (exists)
- `docs/bun.lock` (exists)

The root `bun.lock` will be the single lockfile for all workspaces.

## justfile changes needed

`compile-test-cli` currently runs:
```
bun build --compile --outfile resources/bin/runbooks-test cli/index.ts
```

This should continue to work as-is because `bun build --compile` resolves workspace dependencies.
If it fails, add `--packages=bundle` to force bundling workspace deps:
```
bun build --compile --packages=bundle --outfile resources/bin/runbooks-test cli/index.ts
```

## Execution order checklist

This is the safe order to execute the migration. Each phase should pass its verification test before proceeding.

### Phase 1: Infrastructure (no file moves, no import changes)
- [ ] Add `"workspaces": ["packages/*", "web", "cli", "docs"]` to root `package.json`
- [ ] Workspace package.json files already created (packages/core, packages/shared, cli)
- [ ] Delete `web/bun.lock` and `docs/bun.lock`
- [ ] Run `bun install` from root
- [ ] Verify: `ls -la node_modules/@runbooks/` shows core, shared, cli symlinks

### Phase 2: Move src/ -> packages/core/
- [ ] `git mv src/* packages/core/`
- [ ] Delete `tsconfig.src.json`
- [ ] Update root `tsconfig.json` references (replace tsconfig.src.json with packages/core, packages/shared, cli)
- [ ] Verify: `just typecheck` (will fail until imports are updated, but tsconfig resolution should work)

### Phase 3: Move electron/shared/ -> packages/shared/
- [ ] `git mv electron/shared/channels.ts packages/shared/channels.ts`
- [ ] `rmdir electron/shared` (or `git rm -r electron/shared`)
- [ ] Update `tsconfig.main.json` include: remove `"electron/shared/**/*"`

### Phase 4: Rewrite electron/ imports
- [ ] Replace all `../../../src/` and `../../src/` with `@runbooks/core/` in electron/main/
- [ ] Replace `../shared/channels.ts` with `@runbooks/shared/channels` in electron/preload/
- [ ] Update `electron.vite.config.ts` (externalizeDepsPlugin exclude + resolve aliases)
- [ ] Verify: `just typecheck`, `just build`, `just dev`

### Phase 5: Rewrite cli/ imports
- [ ] Replace all `../../src/` with `@runbooks/core/` in cli/
- [ ] Verify: `just compile-test-cli`

### Phase 6: Rewrite web/ imports
- [ ] Add `"@runbooks/shared": "workspace:*"` to `web/package.json` dependencies
- [ ] Replace `../../electron/shared/channels.ts` with `@runbooks/shared/channels` in `web/src/api.d.ts`
- [ ] Verify: `just build`

### Phase 7: Clean up root deps
- [ ] Remove from root deps: effect, chokidar, yaml, ini, all @aws-sdk/*, mixpanel, commander
- [ ] Add to root deps: `"@runbooks/core": "workspace:*"`, `"@runbooks/shared": "workspace:*"`
- [ ] Run `bun install`
- [ ] Verify: `just build`, `just test-unit`

### Phase 8: Update test config
- [ ] Update `vitest.config.ts` includes to use `packages/core/**/*.test.ts`
- [ ] Verify: `just test-unit`

### Phase 9: Full verification
- [ ] `just package-local` -- DMG/app works
- [ ] `just test-e2e` -- Playwright passes
- [ ] `just test-runbooks` -- CLI binary works

## Overlap warning: subprocess-execution-fix

The subprocess execution fix (see `plans/subprocess-execution-fix.md`) modifies these files:
- `src/domain/exec/executor.ts` -> will become `packages/core/domain/exec/executor.ts`
- `src/layers/ChildProcessSpawner.ts` -> will become `packages/core/layers/ChildProcessSpawner.ts`
- `electron/main/ipc/exec.ts` -> stays at same path, but imports change

**Do NOT begin Phase 2 (file moves) until the subprocess execution fix has landed.**
Phase 1 (workspace infrastructure) and this documentation are safe to do in parallel since they create new files only.
