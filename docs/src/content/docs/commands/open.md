---
title: open
---

# `runbooks open`

Opens a runbook in your default browser with the interactive web interface.

## Usage

```bash
runbooks open <path-to-runbook>
```

## Arguments

- `<path-to-runbook>` - Path to a runbook file (`.mdx` or `.md`) or a directory containing a runbook

## What It Does

When you run `runbooks open`:

1. **Starts the Backend Server** - Launches a Go-based HTTP server on port 7825
2. **Launches the Browser** - Opens your default web browser to `http://localhost:7825`
3. **Serves the Frontend** - The web UI connects to the backend API to process the runbook
4. **Keeps Running** - The server continues running until you close the browser or press Ctrl+C

## Examples

Open a specific runbook file:
```bash
runbooks open ./my-runbook.mdx
```

Open a runbook from a directory:
```bash
runbooks open ./my-runbook-directory/
```

Open a demo runbook:
```bash
runbooks open testdata/demo-runbook-1/runbook.mdx
```

## Technical Details

### Backend Server
- Runs on port 7825 by default
- Serves the React frontend (from `/web/dist` in production)
- Provides REST API endpoints for:
  - Reading and parsing the runbook file
  - Executing commands and checks
  - Parsing and rendering Boilerplate templates
  - Reading and writing generated files

### Frontend Application
- Built with React and Vite
- Uses shadcn/ui components
- Renders markdown with MDX support
- Provides interactive forms and command execution UI

### Browser Auto-Open
The tool automatically:
- Detects your default browser
- Waits for the server to be ready
- Opens the URL once the server is listening
- Keeps the server running as long as the browser is open

## Troubleshooting

**Port already in use:**
If port 7825 is already in use, you'll see an error. Stop any other process using that port or modify the code to use a different port.

**Browser doesn't open:**
If the browser doesn't open automatically, you can manually navigate to `http://localhost:7825` after running the command.

**Runbook not found:**
Make sure the path points to a valid `.mdx` or `.md` file, or a directory containing such a file.

