# AGENTS.md

## Overview

**Runbooks** is a desktop application by [Gruntwork](https://gruntwork.io) that turns interactive MDX documents into executable workflows. Electron main process executes scripts on the user's machine; React renderer displays the UI. Communication is via Electron IPC.

## Project Structure

```
/electron       — Main process, preload, IPC handlers, shared types
/src            — Core backend (Effect services + domain modules), shared by Electron + CLI
/cli            — Standalone test CLI (reuses src/ directly, no IPC)
/web            — Frontend: React 19 + TypeScript + Vite + Tailwind CSS 4
/docs           — Documentation site (Astro + Starlight)
/testdata       — Sample runbooks and test fixtures
/plans          — Architecture plans and research docs
```

See [plans/electron-rewrite.md](plans/electron-rewrite.md) for the full architecture.

## Tooling

| Use this | Not this | Notes |
|---|---|---|
| **bun** | npm / yarn | All JS package management and script running |
| **just** | task / make | See `justfile` for recipes |
| **mise** | nvm | Tool versioning (`.mise.toml`) |
| **oxlint** | eslint | Linting |
| **electron-vite** | manual vite | Builds main, preload, renderer |
| **Effect** | raw promises | Services, layers, typed errors, streams |
| **OpenTofu** | Terraform | IaC examples |

Add shadcn/ui components: `bunx shadcn@latest add <name>`

## Key Commands

```bash
just                  # List all recipes
just dev              # Start Electron in dev mode
just build            # Build the Electron app
just test             # Run all tests
just test-unit        # Vitest (src/ + web/)
just test-e2e         # Playwright
just test-runbooks    # CLI integration tests
just lint             # oxlint
just typecheck        # tsc --noEmit
```

## Conventions

### Code Organization
- Domain modules use `yield* ServiceTag` — never import Node.js APIs or SDKs directly
- Layers are the only place that imports SDKs or Node.js APIs
- Frontend hooks use `useApi()` context — never `window.api` directly
- Blocks: `web/src/components/mdx/<BlockName>/` (PascalCase directories)
- Domain: `src/domain/<module>/` (camelCase files)

### Effect Patterns
- External operations return `Effect<A, E, R>`, never raw Promises in domain code
- Errors use `Data.TaggedError` subclasses
- Resource cleanup via `Scope` (`acquireRelease` / `addFinalizer`)
- Tests swap layers for mock implementations

See [plans/effect-runtime-research.md](plans/effect-runtime-research.md) for known Effect runtime issues.

### Error Reporting in MDX Components
`reportError()` is for **configuration errors only** (duplicate IDs, missing props, invalid configs) — not runtime errors (auth failures, network errors). Runtime errors display inline within the component.

## Testing

### Philosophy
Maximize real code paths. Mock only at true boundaries. Prioritize coverage by risk, not line count. See [plans/electron-rewrite-testing.md](plans/electron-rewrite-testing.md) for the full test plan.

### Running Tests
- **Unit/component tests**: `just test-unit` (Vitest, jsdom for web/)
- **E2E tests**: `just test-e2e` (Playwright, launches Electron)
- **Runbook tests**: `node dist/main/cli.js test /path/to/runbook`

### Writing Runbook Tests
Every runbook needs `runbook_test.yml`. Generate with `node dist/main/cli.js test init /path/to/runbook`. Reference: `testdata/sample-runbooks/my-first-runbook/runbook_test.yml`.

## Blocks

New blocks require: frontend component, IPC handler (if needed), docs, automated tests, and test framework support.

Reference implementations:
- Simple: `Command/` (frontend) + `src/domain/exec/` (backend) + `electron/main/ipc/exec.ts`
- Complex: `AwsAuth/` (frontend) + `src/domain/aws/` (backend) + `electron/main/ipc/aws.ts`

Auth blocks (`AwsAuth`, `GitHubAuth`) must maintain consistency — changes to one should evaluate the same change for the other.

## Don't Do This

- **Don't use npm/yarn** — use bun
- **Don't import Node.js APIs in `src/domain/`** — use Effect services
- **Don't import `electron` in `src/`** — stays in `electron/`
- **Don't use `window.api` directly** — use `useApi()` context
- **Don't call `reportError()` for runtime errors** — only configuration errors
- **Don't create blocks without docs and tests**
- **Don't skip pre-commit hooks** — fix spelling or update `docs/cspell.json`
- On feature branches, don't preserve backward compatibility with earlier versions of the same feature branch

## Bug Fixes

When fixing a bug caused by a repeated pattern, search for all instances before making changes. Fix them all at once or extract a shared function.
