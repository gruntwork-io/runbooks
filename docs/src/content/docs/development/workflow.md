---
title: Development Workflow
---

If you're developing the Runbooks tool itself, this guide covers the day-to-day workflow.

## Prerequisites

All tools are managed via [mise](https://mise.jdx.dev/). Install mise, then run:

```bash
mise install
```

This installs everything you need: Node.js, bun, and [just](https://github.com/casey/just) (command runner).

## Running the Dev Server

A single command starts the full Electron development environment:

```bash
just dev
```

This runs `electron-vite` in dev mode with hot module replacement (HMR) for the renderer process.

It first runs `just fetch-boilerplate`, which downloads the pinned [Boilerplate](https://github.com/gruntwork-io/boilerplate) release (CLI + WASM build) into `resources/`. The app always renders templates with this vendored copy — it never uses a `boilerplate` installed on your `PATH` — so the version you develop against is the same one that ships in the packaged app. To bump it, change `boilerplate_version` in the `justfile` and re-run `just fetch-boilerplate`.

To test a custom Boilerplate build, set `RUNBOOKS_BOILERPLATE_BIN` (path to the CLI) and/or `RUNBOOKS_BOILERPLATE_WASM_DIR` (directory containing `boilerplate-full.wasm.br` and `wasm_exec.js`) before launching. The main process logs a warning at startup whenever an override is active. The CLI and WASM build must come from the same Boilerplate source, or renders will differ between the warm (WASM) and cold (CLI) paths.

## Making Changes

**Frontend (web/src/):**
- Edit files in `web/src/`
- Changes auto-reload in the Electron renderer via HMR
- No restart needed

**Backend (src/):**
- Edit files in `src/`
- Triggers a main process rebuild and restart

**Electron main process (electron/):**
- Edit files in `electron/`
- Triggers a rebuild and restart of the main process

**Runbook changes:**
- Edit the runbook file you're testing with
- Refresh the window
- No restart needed

## Testing

```bash
# Run all tests
just test

# Unit tests (Vitest)
just test-unit

# End-to-end tests (Playwright)
just test-e2e
```

## Building

```bash
# Build the app (electron-vite build)
just build

# Package distributable (electron-builder)
just package
```

## Code Quality

```bash
# Lint (oxlint)
just lint

# Type checking (tsc)
just typecheck
```

## Adding Dependencies

The app has one `package.json` and one `bun.lock`, both at the repo root. They cover the Electron main process, the preload script, the test CLI in `cli/` and the React renderer in `web/`. Neither `cli/` nor `web/` has a `package.json` of its own, so run `bun add` from the repo root. The docs site in `docs/` is the one exception: it is a separate project with its own `package.json` and `bun.lock`.

If your checkout has a `web/node_modules` or `cli/node_modules` with packages in it (left over from a `bun install` run in that directory back when it had its own `package.json`), delete it. Otherwise it shadows the root packages for imports from that directory. `just dev`, `just build`, `just test-web` and `just typecheck` stop with an error until it is gone.

The section a package goes in decides whether it ships inside the packaged app:

- **`dependencies`**: packages that `electron/`, `src/` or `cli/` import at runtime. electron-builder copies these into the app's `node_modules`. Add them with `bun add <package>`.
- **`devDependencies`**: packages that only `web/` imports, plus build and test tools. Vite bundles the renderer's packages into `dist/renderer`, so the app doesn't need its own copy of them. Add them with `bun add -d <package>`.

## Adding shadcn/ui Components

This project uses [shadcn/ui](https://ui.shadcn.com/) for UI components.

To add a new component, run the shadcn CLI from the repo root, where `components.json` lives:

```bash
bunx shadcn@latest add <component-name>
```

For example:
```bash
bunx shadcn@latest add dialog
bunx shadcn@latest add dropdown-menu
```

Components are added to `/web/src/components/ui/`. The CLI installs any packages a component needs with `bun add`, which puts them under `dependencies`. Move them to `devDependencies`, because only the renderer uses them.
