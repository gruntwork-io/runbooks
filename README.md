# runbooks

## Read the docs

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

1. Start Vite to run the React frontend:
   ```bash
   cd web
   bun install
   bun dev
   ```

1. Start the backend HTTP server so that the frontend can interact with the Go binary.
   ```bash
   go run main.go serve /path/to/runbook
   ```

Now you can make changes to the React code in `/web` or to the backend in the applicable `.go` files!

### Adding shadcn/ui components

This project uses [shadcn/ui](https://ui.shadcn.com/) for unstyled components to make use of battle-tested, accessible components. To add a new component, look it up in the shadcn/ui docs, and then use:

```bash
bunx shadcn@latest add <component_name>
```

## Hidden subcommands

### completion
Set up shell auto-completion for bash, zsh, fish, and PowerShell. Use `runbooks completion --help` for setup instructions.

