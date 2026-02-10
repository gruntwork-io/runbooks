# AGENTS.md

## Overview

**Runbooks** is an open-source tool by [Gruntwork](https://gruntwork.io) that turns interactive MDX documents into executable workflows. Infrastructure experts author "runbooks" — markdown files with embedded React components (called "blocks") — that guide users through multi-step processes like deploying infrastructure, running migrations, or onboarding to AWS. The Go backend executes scripts and commands on the user's local machine while the React frontend renders the interactive UI. The final artifact is a single self-contained Go binary with the frontend embedded.

## Project Structure

```
/web          — Frontend: React 19 + TypeScript + Vite + Tailwind CSS 4
/api          — Backend: Go API server (Gin framework, port 7825)
/browser      — Browser launcher (opens the local UI)
/cmd          — CLI commands (Cobra)
/docs         — Documentation site (Astro + Starlight)
/testdata     — Sample runbooks, feature demos, and test fixtures
/scripts      — Shared shell scripts
main.go       — Entrypoint
Taskfile.yml  — Task runner config
```

### Frontend (`/web`)

- **React 19** with TypeScript, built with **Vite**
- **Tailwind CSS 4** for styling
- **shadcn/ui** (Radix primitives) for accessible UI components
- **MDX** (`@mdx-js/mdx`) for rendering runbook content
- **Vitest** for unit tests
- Components live in `web/src/components/`; blocks live in `web/src/components/mdx/`
- Each block is a directory: `web/src/components/mdx/<BlockName>/` containing the main component, `index.ts`, sub-components, hooks, types, and utils

### Backend (`/api`, `/browser`, `/cmd`)

- **Go** (1.25+), using the **Gin** web framework
- **Cobra** for CLI command parsing
- The server runs on **port 7825** by default
- The built binary embeds the frontend via `web/embed.go`
- Testing framework lives in `api/testing/`

### Docs (`/docs`)

- **Astro** with the **Starlight** theme
- Content in `docs/src/content/docs/` as `.md` and `.mdx` files
- Block documentation in `docs/src/content/docs/authoring/blocks/`

## Tooling

| Use this         | Not this       | Notes                                          |
|------------------|----------------|-------------------------------------------------|
| **bun**          | npm / yarn     | All JS package management and script running    |
| **Taskfile.dev** | Make           | See `Taskfile.yml` for available tasks          |
| **OpenTofu**     | Terraform      | For any IaC examples in runbooks or docs        |
| **prek**         | husky          | Pre-commit hook manager (optional)              |

### Adding new shadcn/ui components

First add the component directly into our code base: `bunx shadcn@latest add <component_name>`. Then customize the generated component as needed to adapt it to our needs. The component should be generic and reusable, so if you need a lot of customization, consider creating a new component composed of shadcn/ui components.

## Key Commands

```bash
# List all tasks
task --list

# Build the full binary (frontend + Go)
task build

# Dev servers (run in separate terminals)
task dev:backend RUNBOOK_PATH=testdata/my-first-runbook
task dev:frontend

# Run all tests
task test

# Run tests by category
task test:backend       # Go tests (go test ./...)
task test:frontend      # Vitest (bun run test)
task test:runbooks      # Runbook integration tests
task test:docs          # Spellcheck + link check

# Runbook testing
runbooks test init /path/to/runbook   # Generate runbook_test.yml
runbooks test /path/to/runbook        # Run tests for one runbook
runbooks test ./testdata/...          # Run all runbook tests

# Docs
task docs:spellcheck
task docs:linkcheck
```

## Conventions

### General

- Backend code is in Go; follow standard Go conventions (`gofmt`, etc.)
- Frontend code is TypeScript React; follow the existing ESLint config (`web/eslint.config.js`)
- Use **functional components** and **hooks** for all React code
- File and directory names for blocks use **PascalCase** (e.g., `AwsAuth/`, `TemplateInline/`)
- Go files use **snake_case** (e.g., `aws_auth.go`, `exec_script.go`)
- Test files follow Go convention: `*_test.go` alongside the file they test
- Frontend tests use `.test.ts` / `.test.tsx` suffix

### Commit and PR Conventions

- Keep commits focused on a single logical change
- Pre-commit hooks run spellcheck on docs — if spellcheck fails, fix the spelling or update `docs/cspell.json`
- When making changes, determine whether the user is asking about the **frontend**, **backend**, or **docs**, and scope changes accordingly

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
- Flag any mock of an internal module, utility function, or sibling class that could be used directly. Mocking internals couples tests to implementation details and lets interface mismatches go undetected.
- When mocks are necessary, verify they **faithfully represent** the real interface: correct method signatures, realistic return shapes/types, accurate error behavior. Stale or oversimplified mocks are a common source of false-passing tests.
- Watch for "mock trains" — deep chains of mocked objects returning mocked objects — which almost always indicate the test is too far from reality.
- Where possible, recommend real in-memory alternatives (e.g., SQLite for a database layer, in-memory event buses for message queues) over mocks.

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

Automated tests serve as continuous integration's safety mechanism — they are the brakes that let a team move fast by catching regressions on every commit. To serve this role effectively:

- **Tests must be fast enough to run on every commit.** If the suite takes too long, developers skip it or batch commits, undermining the safety net. Flag tests that are unnecessarily slow due to heavy setup, redundant teardown, or over-broad integration scope.
- **Tests must be deterministic.** Flaky tests that pass or fail randomly destroy trust. Flag tests with race conditions, time-dependent logic, or reliance on external state that isn't controlled.
- **Tests should support small, frequent commits.** The test suite should encourage developers to commit early and often by making it painless to verify changes. A suite that takes 30 minutes to run discourages the small-commit workflow that keeps integration conflicts rare and bugs easy to trace.
- **A failing test must be actionable.** When a test fails, a developer should be able to quickly identify what broke and why. Flag tests with vague assertions, missing context in failure messages, or overly broad scope that could fail for many unrelated reasons.

### 7. Assess the Test Portfolio Balance

A healthy test suite is a portfolio, not a monoculture. Evaluate the overall shape:

- **Too many mocked unit tests, too few integration tests:** High line coverage, low confidence. Bugs hide in the seams between components.
- **Too many end-to-end tests, too few focused tests:** Slow suite, flaky results, hard-to-diagnose failures. Developers stop trusting or running them.
- **Right balance:** A base of focused unit tests for complex pure logic, a middle layer of integration tests using real components wired together, and a thin layer of end-to-end tests for critical user journeys.

As codebase size grows, bug density grows disproportionately. The test portfolio should account for this — larger, more complex modules need proportionally more testing investment, not a uniform distribution.

### Writing Tests for Runbooks

Every new runbook must have an automated test. Follow the [testing guide](docs/src/content/docs/authoring/testing.mdx).

1. Generate a test config: `runbooks test init /path/to/runbook`
2. This creates `runbook_test.yml` next to your `runbook.mdx`
3. Edit the YAML to customize inputs, steps, and assertions
4. Run the test: `runbooks test /path/to/runbook`

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
| Backend handler (if needed)       | `api/<block_name>.go`                                        |
| Block documentation   | `docs/src/content/docs/authoring/blocks/<BlockName>.mdx`     |
| Automated tests       | `testdata/feature-demos/<block-name>/` (runbook + test YAML) |
| Test framework support| `api/testing/` — `runbooks test init` must detect the block, and `runbooks test` must handle it |

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

- **Simple block:** `web/src/components/mdx/Command/` (frontend), `api/exec.go` (backend)
- **Complex block with auth:** `web/src/components/mdx/AwsAuth/` (frontend), `api/aws_auth.go` (backend)
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
- **Don't use Make** — use `task` (Taskfile.dev)
- **Don't use Terraform** — use OpenTofu for all IaC examples
- **Don't modify the test framework to make tests pass** — fix the runbook or the codebase instead
- **Don't call `reportError()` for runtime errors** — only for configuration errors (see [Error Reporting](#error-reporting-in-mdx-components))
- **Don't create blocks without docs, tests, and test framework support** — all four artifacts are required
- **Don't re-implement codebase logic in tests** — reference the source of truth
- **Don't skip pre-commit hooks** — if spellcheck fails, fix the spelling
- When working in a feature branch, do not attempt to preserve backward compatibility with a feature or interface introduced in the feature branch itself. 