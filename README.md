# runbooks

## Development

1. Start Vite to run the React frontend:
    ```
    yarn dev
    ```
2. Start the backend HTTP server so that the frontend can interact with the Go binary.
    ```
    go run main.go open /path/to/runbook
    ```

Now you can make changes to the frontend in `/http` or to the backend in the applicable `.go` file.

## Hidden subcommands

### completion
Set up shell auto-completion for bash, zsh, fish, and PowerShell. Use `runbooks completion --help` for setup instructions.

