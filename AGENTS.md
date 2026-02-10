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

- Use the **source of truth** to recreate program behavior. Do not re-implement logic in the testing framework that already exists in the codebase. Reference the actual code; refactor into public functions if needed.
- When a test fails, assume the problem is with the **runbook configuration** first. Then check the **runbooks codebase**. Only update the test framework if it does not faithfully reproduce how the real codebase behaves.
- **Never "make the tests pass" by weakening the test code.** The goal is to catch both runbook misconfigurations and codebase regressions.

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
- If a test fails, fix the issue and re-run until it passes

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