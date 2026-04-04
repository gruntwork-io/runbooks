# Tooling: VoidZero Stack + mise + just

Use VoidZero open source tools for building, linting, testing, and formatting. Use mise for tool versioning. Use just as the command runner.

## Tool Mapping

| Concern | Current | Replacement | Status |
|---------|---------|-------------|--------|
| Tool versioning | None (implicit) | **mise** | Stable |
| Command runner | Taskfile (Task) | **just** | Stable |
| Build (frontend) | Vite 7 | **Vite** (keep, upgrade as needed) | Stable |
| Build (Electron main/preload) | N/A | **Vite** via `electron-vite` | Stable |
| Test runner | Vitest 1.x | **Vitest** (keep, upgrade) | Stable |
| Linting | ESLint 9 + typescript-eslint | **oxlint** | Stable |
| Formatting | None | **oxfmt** | Beta (Tailwind class sorting built-in) |
| Bundler (under Vite) | Rollup | **Rolldown** (via Vite when available) | RC |

## mise (tool version management)

Replaces ad-hoc version requirements with a declarative `.mise.toml` at project root. All contributors and CI get the same tool versions.

Config: `.mise.toml`
```toml
[tools]
node = "22"
bun = "1.3"

[env]
# Project-wide env vars (optional)
ELECTRON_ENABLE_LOGGING = "1"
```

Tools managed by mise:
- **node** - Required by Electron and the Node.js ecosystem
- **bun** - Package manager and script runner (faster than npm)

Tools NOT managed by mise (installed separately):
- **just** - Command runner (system install via brew/cargo/etc.)
- **mise itself** - Bootstrapped separately

Developers run `mise install` once to get all pinned tool versions.

## just (command runner, replaces Taskfile.yml)

Replaces `Taskfile.yml` (Task) with a `justfile` at project root. just is simpler, has no YAML, supports arguments natively, and doesn't try to be a build system.

Config: `justfile`
```just
# Default recipe: show available commands
default:
    @just --list

# --- Development ---

# Start Electron app in dev mode with HMR
dev:
    electron-vite dev

# Start Electron app pointing at a specific runbook
dev-runbook path="testdata/my-first-runbook":
    electron-vite dev -- --runbook {{path}}

# --- Build ---

# Build the Electron app
build:
    electron-vite build

# Package the Electron app for distribution
package: build
    electron-builder

# Remove build artifacts
clean:
    rm -rf dist out

# --- Test ---

# Run all tests
test: test-unit test-e2e test-runbooks test-docs

# Run unit tests (Vitest)
test-unit:
    bun run vitest

# Run Playwright E2E tests
test-e2e: build
    bunx playwright test

# Run automated runbook tests
test-runbooks: build
    node cli/index.js test testdata/...

# Run docs tests (spellcheck + link check)
test-docs:
    cd docs && bun install && bun run spellcheck && bun run build && bun run linkcheck

# --- Code Quality ---

# Lint with oxlint
lint:
    oxlint .

# Format with oxfmt
fmt:
    oxfmt .

# Check formatting without writing
fmt-check:
    oxfmt --check .

# Type check with TypeScript compiler
typecheck:
    tsc --noEmit

# Run all checks (lint + format check + typecheck)
check: lint fmt-check typecheck
```

### Taskfile.yml → justfile migration

| Taskfile task | justfile recipe | Notes |
|---------------|----------------|-------|
| `task build` | `just build` | `electron-vite build` replaces `go build` |
| `task build:frontend` | (part of `just build`) | electron-vite builds all 3 targets |
| `task clean` | `just clean` | Remove dist/out instead of web/dist + Go binary |
| `task dev:frontend` | `just dev` | Single command, electron-vite handles everything |
| `task dev:backend` | `just dev` | No separate backend - Electron main process IS the backend |
| `task test` | `just test` | Runs all test suites |
| `task test:backend` | `just test-unit` | Go tests become Vitest tests for `src/` modules |
| `task test:frontend` | `just test-unit` | Same Vitest run covers both backend + frontend |
| `task test:runbooks` | `just test-runbooks` | Node.js CLI replaces Go binary |
| `task test:e2e` | `just test-e2e` | Same Playwright, now with Electron |
| `task test:docs` | `just test-docs` | Unchanged |
| `task docs:spellcheck` | `just test-docs` | Combined into one recipe |
| `task docs:linkcheck` | `just test-docs` | Combined into one recipe |

## VoidZero Tools

### Vite (already in use)
- Builds the React renderer for Electron's BrowserWindow
- Builds Electron main process and preload script via `electron-vite` plugin
- Dev mode: HMR for renderer, watch-rebuild for main process
- No change needed - already the project's build tool

### Vitest (already in use)
- Unit tests for `src/` backend modules and `web/src/` frontend code
- Replaces any need for Jest
- E2E tests stay on Playwright (VoidZero doesn't cover E2E)

### oxlint (replaces ESLint)
- 50-100x faster than ESLint, 700+ rules
- Supports TypeScript natively (type-aware linting via tsgo)
- Supports React hooks rules
- Replace: `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals`
- Config: `oxlintrc.json` at project root

### oxfmt (replaces nothing - new addition)
- 30x faster than Prettier
- Built-in Tailwind class sorting (project uses Tailwind)
- Add as formatting standard for the project
- Config: `.oxfmt.json` at project root

## What We Don't Use

| Tool | Why Not |
|------|---------|
| **Vite+** | Alpha, too early for production. Revisit later. |
| **Rolldown** (direct) | Used implicitly through Vite. No need to depend on it directly. When Vite upgrades its internal bundler to Rolldown, we get the benefits automatically. |
| **oxc-parser** | Used implicitly by oxlint/oxfmt. No direct dependency needed. |
| **oxc-transformer** | Vite + SWC already handles TypeScript/JSX transforms. |
| **oxc-minify** | Alpha. Vite handles minification via its bundler. |
| **mise tasks** | mise has a built-in task runner, but we use just instead for clarity of purpose. |

## Electron-Specific Build Setup

Use `electron-vite` (Vite-native Electron build tool):

```
electron-vite builds 3 entry points:
  1. electron/main/index.ts    → main process bundle (Node.js target)
  2. electron/preload/index.ts → preload script bundle (Node.js target, sandboxed)
  3. web/src/main.tsx           → renderer bundle (browser target)
```

Config: `electron.vite.config.ts` at project root:
```typescript
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // @aws-sdk, etc. are externalized
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    // Existing Vite config for the React app
  },
})
```

## Package Changes

### Remove
```
eslint
@eslint/js
typescript-eslint
eslint-plugin-react-hooks
eslint-plugin-react-refresh
globals
eslint.config.js (or equivalent)
Taskfile.yml
```

### Add (project dependencies)
```
oxlint          (linting)
oxfmt           (formatting)
electron-vite   (Electron + Vite integration)
electron        (Electron runtime)
electron-builder (packaging/distribution)
```

### Add (project config files)
```
.mise.toml      (tool versions)
justfile        (command runner)
oxlintrc.json   (linter config)
.oxfmt.json     (formatter config)
electron.vite.config.ts (build config)
```

### Keep
```
vite            (build tool - used by electron-vite)
vitest          (test runner)
@vitejs/plugin-react-swc (React transform)
@playwright/test (E2E testing)
typescript      (type checking - oxlint doesn't replace tsc)
```

## CI (GitHub Actions)

Use `jdx/mise-action` to install mise and project tools in one step:

```yaml
steps:
  - uses: actions/checkout@v4

  - uses: jdx/mise-action@v2
    # Reads .mise.toml, installs node + bun automatically

  - uses: extractions/setup-just@v2

  - run: bun install

  - run: just check   # lint + fmt-check + typecheck
  - run: just test     # all test suites
```

For packaging/distribution jobs, add electron-builder and code signing steps after `just build`.

Note: `tsc --noEmit` is kept for type checking. oxlint provides type-aware linting but doesn't replace the TypeScript compiler for full type checking.
