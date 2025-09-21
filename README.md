# runbooks

## Development

1. Install [Corepack](https://yarnpkg.com/getting-started/install)

   This this is Node's "package manager for package managers" and it will ensure you use the exact
   version of `yarn` that this project uses.

   ```bash
   npm install -g corepack
   corepack enable
   ```

1. Git clone this repo and `cd` to the repo dir.

1. Start Vite to run the React frontend:
    ```
    yarn install
    yarn dev
    ```

1. Start the backend HTTP server so that the frontend can interact with the Go binary.
    ```
    go run main.go serve /path/to/runbook
    ```

Now you can make changes to the React code in `/web` or to the backend in the applicable `.go` files!

## Hidden subcommands

### completion
Set up shell auto-completion for bash, zsh, fish, and PowerShell. Use `runbooks completion --help` for setup instructions.

