# Default recipe: show available commands
default:
    @just --list

# --- Development ---

# Start Electron app in dev mode with HMR
dev:
    mise x node -- npx electron-vite dev

# Start Electron app pointing at a specific runbook
dev-runbook path="testdata/my-first-runbook":
    mise x node -- npx electron-vite dev -- --runbook {{path}}

# --- Build ---

# Build the Electron app (main + preload + renderer)
build:
    mise x node -- npx electron-vite build

# Compile the test CLI as a standalone binary (no Node.js required)
compile-test-cli:
    mise x bun -- bun build --compile --outfile resources/bin/runbooks-test cli/index.ts

# Package the Electron app for distribution
package: build compile-test-cli
    mise x node -- npx electron-builder

# Package for local testing (re-signs with ad-hoc identity for macOS compatibility)
package-local: build compile-test-cli
    #!/usr/bin/env bash
    CSC_IDENTITY_AUTO_DISCOVERY=false mise x node -- npx electron-builder
    if [[ "$(uname)" == "Darwin" ]]; then
        for app in out/mac*/Runbooks.app; do
            [ -d "$app" ] && codesign --force --deep --sign - "$app"
        done
    fi

# Remove build artifacts
clean:
    rm -rf dist out resources/bin/runbooks-test

# --- Test ---

# Run all tests
test: test-unit test-e2e test-runbooks test-docs

# Run unit tests (Vitest)
test-unit:
    mise x bun -- bun run vitest run

# Run Playwright E2E tests (requires build)
test-e2e: build
    mise x bun -- bunx playwright test --config web/playwright.config.ts
    mise x bun -- bunx playwright test --config electron/e2e/playwright.config.ts --workers=1

# Run automated runbook tests via compiled CLI
test-runbooks: build compile-test-cli
    resources/bin/runbooks-test test testdata/...

# Run docs tests (spellcheck + link check)
test-docs:
    cd docs && mise x bun -- bun install && mise x bun -- bun run spellcheck && mise x bun -- bun run build && mise x bun -- bun run linkcheck

# --- Code Quality ---

# Lint with oxlint
lint:
    mise x bun -- bunx oxlint . --ignore-pattern '**/*.astro' --ignore-pattern 'testdata/**'

# Format with oxfmt (when available, placeholder for now)
fmt:
    @echo "oxfmt not yet available — skipping"

# Check formatting without writing
fmt-check:
    @echo "oxfmt not yet available — skipping"

# Type check with TypeScript compiler
typecheck:
    mise x bun -- bunx tsc --noEmit

# Run all checks (lint + format check + typecheck)
check: lint fmt-check typecheck
