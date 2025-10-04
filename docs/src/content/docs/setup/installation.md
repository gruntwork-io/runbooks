---
title: Installation
sidebar:
   order: 1
---

## Installing Runbooks

### Prerequisites

Runbooks is a Go-based CLI tool with a React frontend. To use it, you'll need:

- **Go** (1.19 or later) - for running the backend server
- **Bun** (recommended) or npm - for the React frontend development (only needed if developing the tool itself)

### Quick Install from Source

1. Clone the repository:
   ```bash
   git clone https://github.com/your-org/runbooks.git
   cd runbooks
   ```

2. Build the binary:
   ```bash
   go build -o runbooks main.go
   ```

3. Move the binary to your PATH (optional):
   ```bash
   sudo mv runbooks /usr/local/bin/
   ```

4. Verify installation:
   ```bash
   runbooks --help
   ```

### Using Runbooks

Once installed, you can open any runbook with:

```bash
runbooks open /path/to/runbook.mdx
```

The tool will:
- Start a backend server on port 7825 (configurable)
- Launch your default browser with the runbook interface
- Keep running until you close the browser or press Ctrl+C

### Development Setup

If you want to contribute to Runbooks or modify the frontend:

1. Install Bun:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. Install frontend dependencies:
   ```bash
   cd web
   bun install
   ```

3. Start the frontend dev server:
   ```bash
   bun dev
   ```

4. In a separate terminal, start the backend:
   ```bash
   go run main.go serve /path/to/runbook
   ```

Now you can make changes to the React code in `/web` or to the backend Go code!

### Shell Completion

Runbooks supports shell auto-completion for bash, zsh, fish, and PowerShell:

```bash
# Bash
runbooks completion bash > /etc/bash_completion.d/runbooks

# Zsh
runbooks completion zsh > "${fpath[1]}/_runbooks"

# Fish
runbooks completion fish > ~/.config/fish/completions/runbooks.fish

# PowerShell
runbooks completion powershell > runbooks.ps1
```

See `runbooks completion --help` for more details.
