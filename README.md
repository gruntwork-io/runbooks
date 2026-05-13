<p align="center">
  <a href="https://runbooks.gruntwork.io">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="./web/public/runbooks-logo-light-color.svg" height="80">
      <source media="(prefers-color-scheme: light)" srcset="./web/public/runbooks-logo-dark-color.svg" height="80">
      <img alt="Gruntwork Runbooks" src="./web/public/runbooks-logo-dark-color.svg" height="80">
    </picture>
  </a>
</p>

<p align="center"><em>Runbooks enables infrastructure experts to scale their expertise.</em></p>

Runbooks are interactive markdown documents that enable subject matter experts to capture their knowledge and expertise in a way that is easy for others to understand and use. Runbooks is a desktop application built with Electron that renders MDX documents with embedded React components for executing scripts, managing AWS/GitHub authentication, cloning repos, generating files from templates, and more.

For additional information on Runbooks, or to see it in action, check out the [Runbooks docs](https://runbooks.gruntwork.io).

## Project status

> [!NOTE]
> Runbooks was written by a single author and has not yet had a thorough peer review. GitHub issues identifying issues and pull requests fixing them are welcome!

## Security concerns

Runbooks is designed to streamline the code generation and commands you might otherwise run on your local computer. This has important security implications you should be aware of prior to running Runbooks.

### Command execution

Runbooks executes commands directly on your local computer with the full set of environment variables present when you launched the application. For this reason, it is imperative that you **only open Runbooks you trust.** The Runbooks you open contain arbitrary scripts, and while the Runbooks tool always exposes every last line of code that will be executed, it's easy for long scripts to obscure what they're doing.

If you do not trust a Runbook file or you're not sure about the author or origin, do not open the Runbook.

### Protections against arbitrary command execution

Runbooks uses an executable registry to ensure that only commands and scripts that are part of the Runbook can be executed. The Electron renderer is sandboxed and communicates with the main process via IPC through a typed `contextBridge` API — no direct Node.js access from the renderer. Read the [security docs](http://runbooks.gruntwork.io/security/execution-model/) for more details.

## Installation

### macOS

Download the `.dmg` from the [latest release](https://github.com/gruntwork-io/runbooks/releases) and drag to Applications.

### Linux

Download the `.AppImage` or `.deb` from the [latest release](https://github.com/gruntwork-io/runbooks/releases).

### Windows

Download the `.exe` installer from the [latest release](https://github.com/gruntwork-io/runbooks/releases).

## Building from Source

Prerequisites:
- [mise](https://mise.jdx.dev/) — tool version manager
- [just](https://just.systems/) — command runner

```bash
# Install pinned tool versions (Node.js, bun)
mise install

# Install dependencies
bun install

# Build the Electron app
just build

# Package for distribution (current platform)
just package
```

## Development

1. Install prerequisites:
   - [mise](https://mise.jdx.dev/) — `brew install mise` or see [installation docs](https://mise.jdx.dev/getting-started.html)
   - [just](https://just.systems/) — `brew install just` or see [installation docs](https://just.systems/man/en/packages.html)
   - [prek](https://prek.j178.dev/) — Pre-commit hook manager (optional, for contributors)

2. Clone and set up:

   ```bash
   git clone https://github.com/gruntwork-io/runbooks.git
   cd runbooks
   mise install    # Installs Node.js + bun
   bun install     # Installs npm dependencies
   ```

3. Set up pre-commit hooks (recommended):

   ```bash
   prek install
   ```

4. Start the app in dev mode:

   ```bash
   # Single command — HMR for React, watch-rebuild for main process
   just dev

   # Or point at a specific runbook
   just dev-runbook testdata/my-first-runbook
   ```

### Key commands

```bash
just                 # List all available recipes
just dev             # Dev mode with HMR
just build           # Build the app
just test            # Run all tests
just test-unit       # Vitest unit tests
just test-e2e        # Playwright E2E tests
just lint            # oxlint
just typecheck       # tsc --noEmit
just check           # lint + typecheck
```

### Adding shadcn/ui components

This project uses [shadcn/ui](https://ui.shadcn.com/) for unstyled components to make use of battle-tested, accessible components. To add a new component:

```bash
bunx shadcn@latest add <component_name>
```
