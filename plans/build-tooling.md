# Build Tooling Plan: Bun Everywhere

## Current State

- **Root**: Uses `npm` lockfile, scripts run via `electron-vite`/`electron-builder`
- **web/**: Already uses Bun (`packageManager: "bun@1.3.10"`, `bun.lock`)
- **docs/**: Already uses Bun (`bun.lock`)
- **CLI**: Built as `dist/main/cli.js` by electron-vite, run via `node dist/main/cli.js test ...`
- **justfile**: Uses `mise x node --` for Electron commands, `mise x bun --` for tests

## Target State

| Tool | Current | Target | Notes |
|------|---------|--------|-------|
| Package manager | npm (root), bun (web) | bun everywhere | Add `packageManager` field to root |
| Build | `npx electron-vite build` | `bunx electron-vite build` | Works — bunx executes npm packages |
| Package | `npx electron-builder` | `bunx electron-builder` | Needs platform testing |
| Test CLI | `node dist/main/cli.js` | `runbooks-test` standalone binary | `bun build --compile cli/index.ts` |
| Unit tests | `bun run vitest run` | Same | Already uses Bun |
| E2E tests | `bunx playwright test` | Same | Already uses Bun |

## Changes Required

### 1. Root package.json
- Add `"packageManager": "bun@1.3.10"`
- Replace `npm` scripts with `bunx` versions
- Remove `cli` entry from electron-vite config (build separately)

### 2. Test CLI as standalone binary
```bash
bun build --compile --outfile resources/bin/runbooks-test cli/index.ts
```
- Add to justfile: `compile-test-cli` recipe
- Include in `electron-builder` extraResources for distribution
- `runbooks` wrapper script delegates `test` subcommand to `runbooks-test`

### 3. justfile simplification
```just
dev:
    bunx electron-vite dev
build:
    bunx electron-vite build
package: build
    bunx electron-builder
compile-test-cli:
    bun build --compile --outfile resources/bin/runbooks-test cli/index.ts
```

### 4. Electron app installs `runbooks-test`
- `electron/main/cli-install.ts` creates symlinks for both `runbooks` and `runbooks-test`
- `runbooks test` delegates to `runbooks-test` binary

## Important: Bun Cannot Be Electron Runtime
Electron uses Node.js — Bun cannot replace it as the runtime. Bun is used for:
- Package management (`bun install`, `bun add`)
- Running scripts (`bun run`, `bunx`)
- Compiling the test CLI (`bun build --compile`)
- Test execution (`bun run vitest`)
