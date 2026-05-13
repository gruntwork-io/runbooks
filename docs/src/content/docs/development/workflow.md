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

## Adding shadcn/ui Components

This project uses [shadcn/ui](https://ui.shadcn.com/) for UI components.

To add a new component:

```bash
cd web
bunx shadcn@latest add <component-name>
```

For example:
```bash
bunx shadcn@latest add dialog
bunx shadcn@latest add dropdown-menu
```

Components are added to `/web/src/components/ui/`.
