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

Runbooks are interactive markdown documents that enable subject matter experts to capture their knowledge and expertise in a way that is easy for others to understand and use.

For additional information on Runbooks, or to see it in action, check out the [Runbooks docs](https://runbooks.gruntwork.io).

## Project status

> [!NOTE]
> As of December 2025, Runbooks was written by a single author and has not yet had a thorough peer review. GitHub issues identifying issues and pull requests fixing them are welcome!

## Security concerns

Runbooks is designed to streamline the code generation and commands you might otherwise run on your local computer. This has important security implications you should be aware of prior to running Runbooks.

### Command execution

Runbooks executes commands directly on your local computer with the full set of environment variables present when you launched the `runbooks` binary. For this reason, it is imperative that you **only open Runbooks you trust.** The Runbooks you open contain arbitrary scripts, and while the Runbooks tool always exposes every last line of code that will be executed, it's easy for long scripts to obscure what they're doing.

If you do not trust a Runbook file or you're not sure about the author or origin, do not open the Runbook.

### Protections against arbitrary command execution

Runbooks executes commands when the Runbooks frontend makes API calls the Runbooks backend. Runbooks takes various [security measures](http://runbooks.gruntwork.io/security/execution-model/) to make sure that only commands and scripts that are part of the Runbook can be executed via this API, however there are some modes where these restrictions are relaxed in favor of more convenience. Read the docs to understand the security posture in more depth.

## Building

This project uses [Task](https://taskfile.dev/) as a task runner. Install it first:

```bash
# macOS
brew install go-task

# Or see https://taskfile.dev/installation/ for other methods
```

Then build the complete binary:

```bash
task build
```

This will:
1. Build the frontend (`web/dist`)
2. Embed the frontend into the Go binary
3. Output a self-contained `runbooks` binary

Other useful tasks:

```bash
task --list     # List all available tasks
task clean      # Remove build artifacts
```

## Development

1. Install prerequisites:
   - [Bun](https://bun.sh/docs/installation) - JavaScript runtime and package manager
   - [Go](https://go.dev/doc/install) - Go compiler
   - [Task](https://taskfile.dev/installation/) - Task runner
   - [prek](https://prek.j178.dev/) - Pre-commit hook manager (optional, for contributors)

1. Git clone this repo and `cd` to the repo dir.

1. Set up pre-commit hooks (recommended):

   ```bash
   prek install
   ```

   This installs git hooks that automatically run spellcheck on documentation before each commit. If you don't have prek installed, you can install it via:

   ```bash
   # macOS/Linux
   brew install prek

   # Or via the standalone installer
   curl --proto '=https' --tlsv1.2 -LsSf https://github.com/j178/prek/releases/latest/download/prek-installer.sh | sh

   # Or via bun/npm
   bun install -g @j178/prek
   ```

1. Start the backend and frontend dev servers in separate terminals:

   ```bash
   # Terminal 1: Backend API server
   task dev:backend RUNBOOK_PATH=testdata/my-first-runbook

   # Terminal 2: Frontend dev server (Vite with hot reload)
   task dev:frontend
   ```

Now you can make changes to the React code in `/web` or to the backend in the applicable `.go` files! The frontend will hot-reload automatically. For Go changes, restart the `dev:backend` task.

### Adding shadcn/ui components

This project uses [shadcn/ui](https://ui.shadcn.com/) for unstyled components to make use of battle-tested, accessible components. To add a new component, look it up in the shadcn/ui docs, and then use:

```bash
bunx shadcn@latest add <component_name>
```

