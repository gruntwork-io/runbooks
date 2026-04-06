# AGENTS.md

## Overview

**Runbooks** is an open-source desktop application by [Gruntwork](https://gruntwork.io) that turns interactive MDX documents into executable workflows. Infrastructure experts author "runbooks" — markdown files with embedded React components (called "blocks") — that guide users through multi-step processes like deploying infrastructure, running migrations, or onboarding to AWS. The Electron main process executes scripts and commands on the user's local machine while the React renderer displays the interactive UI. Communication between frontend and backend happens via Electron IPC (not HTTP).

## Project Structure

```
/electron       — Electron main process, preload script, shared IPC types
  /main         — App entry, window lifecycle, menu, updater, CLI arg parsing
  /main/ipc     — IPC handlers (thin wrappers over src/ domain modules)
  /preload      — contextBridge exposing typed window.api
  /shared       — IPC channel constants + types
/src            — Core backend modules (shared by Electron + CLI), built on Effect
  /services     — Effect service definitions (Context.Tag + interface)
  /layers       — Live implementations (only place that imports SDKs/node APIs)
  /domain       — Business logic (uses services via yield*, never imports node APIs)
  /errors       — Error barrel file (typed errors are co-located with their domain modules)
  /test-utils   — Test layers with mock implementations
/cli            — Node.js CLI (test runner), reuses src/ modules directly
/web            — Frontend: React 19 + TypeScript + Vite + Tailwind CSS 4
/docs           — Documentation site (Astro + Starlight)
/testdata       — Sample runbooks, feature demos, and test fixtures
/build          — Electron packaging assets (icons, entitlements)
```

### Backend (`/src`)

- **TypeScript** with **Effect** for dependency injection, typed errors, and resource safety
- Domain modules use `yield* ServiceTag` to access dependencies — never import Node.js APIs or SDKs directly
- All external side-effects are modeled as Effect services with typed errors
- Live implementations (layers) are the only place that imports SDKs or Node.js APIs
- 8 services: FileSystem, ProcessSpawner, Environment, AwsClient, GitHubClient, GitClient, BoilerplateRenderer, Telemetry
- Tests swap layers to provide mock implementations — no real external services needed

### Electron Main Process (`/electron`)

- IPC handlers bridge Effect to Electron — call `runtime.runPromise()` on domain modules
- Streaming operations (exec, git clone) use `event.sender.send()` for real-time events
- Native handlers: file dialogs, external URL opening, app info

### Frontend (`/web`)

- **React 19** with TypeScript, built with **Vite** (via `electron-vite`)
- **Bun** as the javascript runtime
- **Tailwind CSS 4** for styling
- **shadcn/ui** (Radix primitives) for accessible UI components
- **MDX** (`@mdx-js/mdx`) for rendering runbook content
- **Vitest** for unit tests
- Hooks use `window.api.invoke()` for IPC (not fetch). All hooks go through `useApi()` React context for testability
- Components live in `web/src/components/`; blocks live in `web/src/components/mdx/`
- Each block is a directory: `web/src/components/mdx/<BlockName>/` containing the main component, `index.ts`, sub-components, hooks, types, and utils

### CLI Test Runner (`/cli`)

- Standalone Node.js CLI that reuses `src/` modules directly (no IPC, no Electron)
- Runs automated runbook tests from `runbook_test.yml` config files
- Built via `electron-vite build` alongside the main app

### Docs (`/docs`)

- **Astro** with the **Starlight** theme
- Content in `docs/src/content/docs/` as `.md` and `.mdx` files
- Block documentation in `docs/src/content/docs/authoring/blocks/`

## Tooling

| Use this         | Not this            | Notes                                          |
|------------------|---------------------|-------------------------------------------------|
| **bun**          | npm / yarn          | All JS package management and script running    |
| **just**         | task / make         | See `justfile` for available recipes            |
| **mise**         | nvm / manual install | Tool versioning (`.mise.toml`): Node.js, bun   |
| **oxlint**       | eslint              | Linting (50-100x faster)                       |
| **electron-vite**| manual vite config  | Builds main, preload, and renderer              |
| **Effect**       | manual DI / raw promises | Services, layers, typed errors, streams    |
| **OpenTofu**     | Terraform           | For any IaC examples in runbooks or docs        |

### Adding new shadcn/ui components

First add the component directly into our code base: `bunx shadcn@latest add <component_name>`. Then customize the generated component as needed to adapt it to our needs. The component should be generic and reusable, so if you need a lot of customization, consider creating a new component composed of shadcn/ui components.

## Key Commands

```bash
# List all recipes
just

# Start Electron app in dev mode (HMR for renderer, watch-rebuild for main)
just dev

# Start with a specific runbook
just dev-runbook testdata/my-first-runbook

# Build the Electron app
just build

# Package for distribution
just package

# Run all tests
just test

# Run tests by category
just test-unit       # Vitest (src/ + web/)
just test-e2e        # Playwright
just test-runbooks   # Runbook integration tests via CLI
just test-docs       # Spellcheck + link check

# Runbook testing
node dist/main/cli.js test init /path/to/runbook   # Generate runbook_test.yml
node dist/main/cli.js test /path/to/runbook         # Run tests for one runbook
node dist/main/cli.js test ./testdata/...           # Run all runbook tests

# Code quality
just lint            # oxlint
just typecheck       # tsc --noEmit
just check           # lint + typecheck
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Electron App                        │
│                                                      │
│  ┌──────────────┐    IPC     ┌───────────────────┐  │
│  │   Renderer    │◄────────►│   Main Process     │  │
│  │   (React)     │           │                    │  │
│  │   web/src/    │           │  electron/main/    │  │
│  │               │           │  ipc/ handlers     │  │
│  └──────────────┘           │         │          │  │
│                              │         ▼          │  │
│                              │  ┌─────────────┐  │  │
│                              │  │ Effect       │  │  │
│                              │  │ Runtime      │  │  │
│                              │  │ (AppLayer)   │  │  │
│                              │  └──────┬──────┘  │  │
│                              └─────────┼─────────┘  │
│                                        │             │
│                              ┌─────────▼─────────┐  │
│                              │   src/domain/      │  │
│                              │   Business Logic   │  │
│                              │   (Effect services)│  │
│                              └───────────────────┘  │
└─────────────────────────────────────────────────────┘
```

- **Renderer** → IPC invoke/on → **Main Process** → Effect runtime → **Domain modules**
- Domain modules depend on service interfaces, never on concrete implementations
- IPC replaces all HTTP routes — no REST API, no SSE streams
- Streaming uses IPC events (`event.sender.send()`) instead of SSE

## Conventions

### General

- All backend code is TypeScript; follow Effect patterns for services/layers/domain
- Frontend code is TypeScript React
- Use **functional components** and **hooks** for all React code
- File and directory names for blocks use **PascalCase** (e.g., `AwsAuth/`, `TemplateInline/`)
- Domain modules use **camelCase** files (e.g., `auth.ts`, `executor.ts`)
- Frontend tests use `.test.ts` / `.test.tsx` suffix
- Domain modules never import `electron`, Node.js APIs, or external SDKs — only Effect services via `yield*`

### Effect Patterns

- All external operations return `Effect<A, E, R>` — never raw Promises in domain code
- Errors are always typed with `Data.TaggedError` subclasses, never plain strings or `Error`
- Layers contain no business logic — adapters only translate between service interfaces and external APIs
- Resource cleanup uses `Scope` — temp files, watchers, WASM instances use `acquireRelease` or `addFinalizer`
- Frontend uses `useApi()` context — never `window.api` directly
- Tests never need real external services — swap Layers, not implementations

### Documentation Tables

When a markdown table row is too wide to read without horizontal scrolling, break the content using `<br/>` tags within the cell to keep each line scannable. If a single cell contains a list of items (e.g., type mappings), put one item per line using `<br/>`. Prefer shorter phrasing in table cells and move lengthy explanations to prose below the table.

### Markdown with Nested Code Fences

When the user asks you to output markdown that itself contains code fences (e.g., a prompt template, a README draft, or any markdown document with embedded code blocks), **write it to a file** instead of rendering it inline. Triple-backtick code fences cannot be nested in a chat message — the inner fences close the outer fence, breaking the formatting. Writing to a file avoids this entirely and lets the user view the rendered result in the editor.

### Commit and PR Conventions

- Keep commits focused on a single logical change
- Pre-commit hooks run spellcheck on docs — if spellcheck fails, fix the spelling or update `docs/cspell.json`
- When making changes, determine whether the user is asking about the **frontend**, **backend** (`src/`), **Electron main process** (`electron/`), or **docs**, and scope changes accordingly

## Error Reporting in MDX Components

The `useErrorReporting()` hook and `reportError()` function are for **configuration errors only** — problems with how the runbook MDX is written. These trigger the "This runbook has issues" banner.

**DO report** (configuration errors):
- Duplicate component IDs
- Missing required props
- Invalid prop values/combinations
- Malformed configurations

**DO NOT report** (runtime/operational errors):
- Authentication failures (bad credentials, expired tokens)
- Network errors during API calls
- AWS/cloud provider API errors
- User input validation failures during execution

Runtime errors should be displayed inline within the component (e.g., with an alert box) but should NOT call `reportError()`. The distinction: configuration errors are problems with the runbook itself; runtime errors are problems that occur when a user interacts with a correctly-configured runbook.

## Testing

### Philosophy

### Guiding Philosophy: Smart Coverage Over Complete Coverage

**Do not pursue 100% coverage for its own sake.** Testing is a trade-off, and every test should justify its existence against three factors:

1. **Likelihood of bugs** — Complex logic, intricate state management, code touched by many contributors, and areas with high churn are where bugs concentrate. Focus testing energy here.
2. **Cost of bugs** — A bug in a payment flow, authentication layer, or data pipeline is catastrophically more expensive than a bug in a tooltip. Weight your coverage toward high-consequence code paths.
3. **Cost of testing** — Integration and UI tests are expensive to write, slow to run, and brittle to maintain. A test that costs more to maintain than the bugs it catches is a net negative.

This means:

- **Not all code deserves the same test investment.** Simple pass-through functions, trivial getters/setters, and thin wrappers around well-tested libraries often don't need dedicated tests.
- **Prefer fewer, high-signal tests over many shallow ones.** One well-designed test that exercises a real workflow through multiple layers catches more bugs than ten isolated unit tests with mocked-out dependencies.
- **Dead tests are worse than no tests.** Tests that always pass regardless of code changes provide false confidence. Tests that are skipped, ignored, or flaky erode trust in the entire suite.

### Best practices

### 1. Maximize Use of Real Code Paths

- Tests should call the actual production code — real functions, real classes, real methods — not reimplementations or simplified stand-ins.
- When a test duplicates production logic (e.g., re-computing an expected value using the same algorithm it's testing), flag it. Tests should verify behavior against **independently known correct outcomes**, not mirror the implementation.
- Prefer integration-style tests that wire together real components over unit tests that mock every dependency, unless isolation is genuinely necessary.

### 2. Mock Only at True Boundaries

- Mocks, stubs, and fakes are justified **only** at external boundaries: network calls, databases, file systems, third-party APIs, time/randomness, and other non-deterministic or side-effectful dependencies.
- In this project, use **Effect test layers** (in `src/test-utils/`) to swap service implementations — this is the preferred mocking mechanism. The compiler verifies all services are provided.
- Flag any mock of an internal module, utility function, or sibling class that could be used directly. Mocking internals couples tests to implementation details and lets interface mismatches go undetected.
- When mocks are necessary, verify they **faithfully represent** the real interface: correct method signatures, realistic return shapes/types, accurate error behavior.
- Where possible, recommend real in-memory alternatives over mocks.

### 3. Verify Test Fidelity to Real Behavior

- Check that test setup (fixtures, factories, seed data) reflects realistic production state, not contrived minimal cases that skip important code paths.
- Ensure error/edge-case tests trigger errors the **same way** production would encounter them, not by artificially injecting impossible states.
- Confirm that test assertions check **meaningful outcomes** (return values, state changes, observable side effects) rather than implementation details (which private method was called, in what order).
- Flag tests that only assert "no error was thrown" without verifying the actual result.

### 4. Detect Drift Between Tests and Production Code

- Identify tests that reference outdated interfaces, deprecated methods, removed parameters, or renamed fields — signs the tests haven't kept pace with the real code.
- Look for test helpers or shared fixtures that silently diverge from how production code constructs or initializes objects.
- Flag hardcoded expected values that may have been correct once but no longer match current behavior.

### 5. Prioritize Coverage by Risk, Not by Line Count

Rather than checking whether every line is covered, evaluate whether the **right things** are covered:

- **High risk, must cover:** Complex business logic, financial/payment flows, authentication and authorization, data validation and transformation, error handling for known failure modes, security-sensitive operations.
- **Medium risk, should cover:** Core CRUD operations, state transitions, API contracts (request/response shapes), integrations between internal modules.
- **Low risk, cover if cheap:** Simple delegation/pass-through, configuration wiring, UI cosmetic rendering, trivial getters/setters.
- **Skip unless there's a specific reason:** Auto-generated code, third-party library internals, one-line wrappers with no logic.

Flag cases where coverage effort is **inverted** — heavy testing on low-risk trivia while high-risk business logic has gaps.

### 6. Tests as Safety Brakes, Not Bureaucracy

- **Tests must be fast enough to run on every commit.** Flag tests that are unnecessarily slow due to heavy setup, redundant teardown, or over-broad integration scope.
- **Tests must be deterministic.** Flag tests with race conditions, time-dependent logic, or reliance on external state that isn't controlled.
- **Tests should support small, frequent commits.**
- **A failing test must be actionable.** When a test fails, a developer should be able to quickly identify what broke and why.

### 7. Assess the Test Portfolio Balance

A healthy test suite is a portfolio, not a monoculture:

- **Too many mocked unit tests, too few integration tests:** High line coverage, low confidence. Bugs hide in the seams between components.
- **Too many end-to-end tests, too few focused tests:** Slow suite, flaky results, hard-to-diagnose failures.
- **Right balance:** A base of focused unit tests for complex pure logic, a middle layer of integration tests using real components wired together, and a thin layer of end-to-end tests for critical user journeys.

### Writing Tests for Runbooks

Every new runbook must have an automated test. Follow the [testing guide](docs/src/content/docs/authoring/testing.mdx).

1. Generate a test config: `node dist/main/cli.js test init /path/to/runbook`
2. This creates `runbook_test.yml` next to your `runbook.mdx`
3. Edit the YAML to customize inputs, steps, and assertions
4. Run the test: `node dist/main/cli.js test /path/to/runbook`

Look at `testdata/sample-runbooks/my-first-runbook/runbook_test.yml` for a well-commented reference example.

### What to Test

- If the runbook has **locally run scripts**, test them
- If the runbook has **integration tests** (third-party dependencies like AWS), **skip those** in automated tests
- If a test fails, first see if the problem is with the runbook configuration. If not, then check the runbooks code. Only update the test framework itself if it does not faithfully reproduce how the real codebase behaves. Never "make the tests pass" by weakening the test code. The goal is to catch both runbook misconfigurations and codebase regressions.

## Blocks

### Creating New Blocks

When defining a new block, you must add **all** of the following:

| What                  | Where                                                        |
|-----------------------|--------------------------------------------------------------|
| Frontend component    | `web/src/components/mdx/<BlockName>/`                        |
| Backend domain module (if needed) | `src/domain/<module>/`                            |
| IPC handler (if needed) | `electron/main/ipc/<module>.ts`                            |
| Block documentation   | `docs/src/content/docs/authoring/blocks/<BlockName>.mdx`     |
| Automated tests       | `testdata/feature-demos/<block-name>/` (runbook + test YAML) |
| Test framework support| `cli/test/` — test init must detect the block, and test must handle it |

#### Block directory structure (frontend)

```
web/src/components/mdx/<BlockName>/
├── <BlockName>.tsx       # Main component
├── index.ts              # Re-export
├── types.ts              # TypeScript types
├── utils.ts              # Utilities (optional)
├── constants.ts          # Constants (optional)
├── components/           # Sub-components (optional)
│   └── SomeChild.tsx
└── hooks/                # Custom hooks (optional)
    └── use<BlockName>.ts
```

#### Reference implementations

- **Simple block:** `web/src/components/mdx/Command/` (frontend), `src/domain/exec/` (backend), `electron/main/ipc/exec.ts` (IPC)
- **Complex block with auth:** `web/src/components/mdx/AwsAuth/` (frontend), `src/domain/aws/` (backend), `electron/main/ipc/aws.ts` (IPC)
- **Block docs:** `docs/src/content/docs/authoring/blocks/AwsAuth.mdx`
- **Test config:** `testdata/sample-runbooks/my-first-runbook/runbook_test.yml`

### Auth Blocks

Auth blocks (`AwsAuth`, `GitHubAuth`) should maintain **consistency** across:
- End-user experience
- Test behavior
- Documentation structure
- Component interfaces

When making changes to one auth block, evaluate whether the same change should be applied to the others.

## Backward compatibility

Runbooks is currently in beta and it is acceptable to make sweeping breaking changes if necessary. Later, when we approach 1.0, we will stabilize the interface. Therefore, prefere more elegant mental models and data structures, even if it means we lose backwards compatibility.

### On feature branches

If code or a feature was created on a feature branch, do not prioritize backwards-compatibility at all. Instead, remove the legacy code entirely. This way, the feature branch shows our best thinking versus preserving backward compatibility merely for an earlier version of the feature branch.

## Don't Do This

- **Don't use `npm` or `yarn`** — use `bun` for all JS/TS operations
- **Don't use Make or Task** — use `just` (see `justfile`)
- **Don't use Terraform** — use OpenTofu for all IaC examples
- **Don't import Node.js APIs or SDKs in `src/domain/`** — use Effect services via `yield*`
- **Don't import `electron` in `src/`** — the Electron dependency stays in `electron/`
- **Don't use `window.api` directly in React** — use the `useApi()` context hook
- **Don't modify the test framework to make tests pass** — fix the runbook or the codebase instead
- **Don't call `reportError()` for runtime errors** — only for configuration errors (see [Error Reporting](#error-reporting-in-mdx-components))
- **Don't create blocks without docs, tests, and test framework support** — all artifacts are required
- **Don't re-implement codebase logic in tests** — reference the source of truth
- **Don't skip pre-commit hooks** — if spellcheck fails, fix the spelling
- When working in a feature branch, do not attempt to preserve backward compatibility with a feature or interface introduced in the feature branch itself.

## Bug fixes

When fixing a bug caused by a repeated code pattern, search for all instances of that pattern before making changes. That is, before fixing, find every instance of this pattern in the file, package, codebase, or project area and fix them all at once. If you extract a function, be sure to scan the codebase for anyone else who should use that new function.
