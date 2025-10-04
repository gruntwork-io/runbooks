---
title: Overview
sidebar:
  order: 1
---

The Runbooks CLI provides several commands for working with runbooks.

## Available Commands

### `open`
Opens a runbook in your default browser with the interactive web interface.

```bash
runbooks open <path-to-runbook>
```

This is the primary command for using runbooks. It starts the backend server and launches the browser automatically.

### `serve`
Starts only the backend API server without opening the browser.

```bash
runbooks serve <path-to-runbook>
```

This is useful for development when you're running the frontend separately (e.g., with `bun dev`).

### `watch`
Continuously watches a runbook for changes and reloads automatically.

```bash
runbooks watch <path-to-runbook>
```

**Status**: Coming soon! This command is planned but not yet implemented.

### `completion`
Generates shell completion scripts for bash, zsh, fish, and PowerShell.

```bash
runbooks completion <shell>
```

This is a hidden command (not shown in `--help` by default) but available for setting up shell auto-completion.

## Global Flags

- `--help` - Show help for any command
- `-h` - Short form of --help

## Examples

Open a runbook:
```bash
runbooks open ./my-runbook.mdx
```

Open a runbook from a directory (looks for `runbook.mdx` or `runbook.md`):
```bash
runbooks open ./my-runbook-dir/
```

Serve the backend for development:
```bash
runbooks serve ./testdata/demo-runbook-1/runbook.mdx
```

Generate bash completion:
```bash
runbooks completion bash > /etc/bash_completion.d/runbooks
```

## Default Port

The backend server runs on **port 7825** by default. This port is used for communication between the React frontend and the Go backend.

