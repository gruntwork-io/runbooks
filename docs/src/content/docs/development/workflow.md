---
title: Development workflow
---

This page is for people working on the Runbooks app itself.

## Prerequisites

[mise](https://mise.jdx.dev/) manages the tool versions. Install mise, then run:

```bash
mise install
```

This installs Node.js, bun, and the [just](https://github.com/casey/just) command runner.

## Running the app in dev mode

```bash
just dev
```

`just dev-runbook <path>` does the same and opens the runbook at that path. Without a path it opens `testdata/sample-runbooks/my-first-runbook`.

This runs `electron-vite` in dev mode with hot module replacement (HMR) for the renderer process.

It first runs `just fetch-boilerplate`, which downloads the pinned [Boilerplate](https://github.com/gruntwork-io/boilerplate) release (CLI + WASM build) into `resources/`. The app renders templates with this vendored copy and ignores any `boilerplate` on your `PATH`, so you develop against the version that ships in the packaged app. To bump it, change `boilerplate_version` in the `justfile` and re-run `just fetch-boilerplate`.

To test a custom Boilerplate build, set `RUNBOOKS_BOILERPLATE_BIN` (path to the CLI) and/or `RUNBOOKS_BOILERPLATE_WASM_DIR` (directory containing `boilerplate-full.wasm.br` and `wasm_exec.js`) before launching. The main process logs a warning at startup whenever an override is active. The CLI and WASM build must come from the same Boilerplate source, or renders will differ between the warm (WASM) and cold (CLI) paths.

## Making changes

| You edit | What happens |
|----------|--------------|
| `web/src/` | The renderer picks up the change through HMR. No restart. |
| `src/` or `electron/` | The main process rebuilds and restarts. |
| The runbook you're testing with | Nothing, until you reload the window with **View > Reload**. |

## Testing

```bash
# Everything below, in this order
just test

# Unit tests (Bun test runner for src/, Vitest for web/ and test/integration/)
just test-unit

# End-to-end tests (Playwright). Builds the app first.
just test-e2e

# Runbook tests: runs the compiled test CLI on every runbook under testdata/
just test-runbooks

# Docs: spellcheck, build, and link check
just test-docs
```

## Building

```bash
# Build the app (electron-vite build)
just build

# Package distributable (electron-builder)
just package
```

## Code quality

```bash
# Lint (oxlint)
just lint

# Format (oxfmt). `just fmt-check` reports without writing.
just fmt

# Unused files, exports and dependencies (knip)
just knip

# Type checking (tsc -b)
just typecheck

# lint, fmt-check, knip and typecheck together
just check
```

## Adding dependencies

The app has one `package.json` and one `bun.lock`, both at the repo root. They cover the Electron main process, the preload script, the test CLI in `cli/` and the React renderer in `web/`. Neither `cli/` nor `web/` has a `package.json` of its own, so run `bun add` from the repo root. The docs site in `docs/` is the one exception: it is a separate project with its own `package.json` and `bun.lock`.

If your checkout has a `web/node_modules` or `cli/node_modules` with packages in it, delete it. It shadows the root packages for imports from that directory. These commands stop with an error until it is gone:

- `just dev`, `just dev-runbook`, `just build`, `just typecheck`, `just compile-test-cli`, `just test-backend`, `just test-web`, `just test-integration` and `just test-e2e-run`, and every recipe that depends on one of them, such as `just package` and `just test`.
- `bun run dev`, `bun run build`, `bun run preview`, `bun run typecheck`, `bun run test`, `bun run test:backend`, `bun run test:web`, `bun run test:watch`, `bun run test:coverage`, `bun run test:integration`, `bun run test:e2e` and `bun run test:electron-e2e`. Running `electron-vite` directly, or `vitest` or Playwright on the tests in `web/`, is covered too, because their config files (`electron.vite.config.ts`, `web/vitest.config.ts` and `web/playwright.config.ts`) run the check.

Running `tsc`, `bun test` or `bun cli/index.ts` directly skips the check. `bun scripts/no-nested-node-modules.ts` runs it on its own.

The section a package goes in decides whether it ships inside the packaged app:

- `dependencies` is for packages that `electron/`, `src/` or `cli/` import at runtime. electron-builder copies these into the app's `node_modules`. Add them with `bun add <package>`.
- `devDependencies` is for packages that only `web/` imports, plus build and test tools. Vite bundles the renderer's packages into `dist/renderer`, so the app doesn't need its own copy of them. Add them with `bun add -d <package>`.

## Adding shadcn/ui components

The renderer's UI components come from [shadcn/ui](https://ui.shadcn.com/). To add one, run the shadcn CLI from the repo root, where `components.json` lives:

```bash
bunx shadcn@latest add <component-name>
```

The CLI writes the component to `web/src/components/ui/`. It installs any packages a component needs with `bun add`, which puts them under `dependencies`. Move them to `devDependencies`, because only the renderer uses them.
