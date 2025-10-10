# Gruntwork Runbooks

_Make the knowledge and experience of the few available to the many._

Runbooks are interactive markdown documents with a first-class experience for generating files based on custom configurations, running customizable scripts or commands, and validating assertions about their local system or infrastructure.

For additional information on Runbooks, or to see them in action, check out the [Runbooks docs](https://runbooks.gruntwork.io).

## Project status

> [!NOTE]
> As of October 2025, Runbooks was written by a single author and has not yet had a thorough peer review. GitHub issues identifying issues and pull requests fixing them are welcome!

## Security concerns

Runbooks are designed to streamline the code generation and commands you might otherwise run on your local computer. This has important security implications you should be aware of prior to running Runbooks.

### Command execution

Runbooks executes commands directly on your local computer with the full set of environment variables present when you launched the `runbooks` binary. For this reason, it is imperative that you **only open Runbooks you trust.** The Runbooks you open contain arbitrary scripts, and while the Runbooks tool always exposes every last line of code that will be executed, it's easy for long scripts to obscure what they're doing.

If you do not trust a Runbook file or you're not sure about the author or origin, do not open the Runbook.

### Protections against arbitrary command execution

Runbooks executes commands when the Runbooks frontend makes API calls the Runbooks backend. Runbooks takes various [security measures](http://runbooks.gruntwork.io/security/execution-model/) to make sure that only commands and scripts that are part of the Runbook can be executed via this API, however there are some modes where these restrictions are relaxed in favor of more convenience. Read the docs to understand the security posture in more depth.

## Read the docs

For now, you'll need to manually launch the docs site by doing the following:

1. Install [Bun](https://bun.sh/docs/installation)

   Bun is a fast JavaScript runtime and package manager that works out of the box.

1. Git clone this repo and `cd` to the repo dir.

1. Start Vite to run the React frontend:
   ```bash
   cd docs
   bun install
   bun dev
   ```

## Development

1. Install [Bun](https://bun.sh/docs/installation)

   Bun is a fast JavaScript runtime and package manager that works out of the box.

1. Git clone this repo and `cd` to the repo dir.

1. Start the backend HTTP server so that the frontend can interact with the Go binary.
   ```bash
   go run main.go serve /path/to/runbook.mdx
   ```

1. Start Vite to run the React frontend:
   ```bash
   cd web
   bun install
   bun dev
   ```

Now you can make changes to the React code in `/web` or to the backend in the applicable `.go` files! If you update Go files, don't forget to re-compile the Go code.

### Adding shadcn/ui components

This project uses [shadcn/ui](https://ui.shadcn.com/) for unstyled components to make use of battle-tested, accessible components. To add a new component, look it up in the shadcn/ui docs, and then use:

```bash
bunx shadcn@latest add <component_name>
```

