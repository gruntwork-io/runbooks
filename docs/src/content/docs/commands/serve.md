---
title: serve
---

# `runbooks serve`

Starts the backend API server without opening the browser. This command is useful for local development.

## Usage

```bash
runbooks serve <path-to-runbook>
```

## Arguments

- `<path-to-runbook>` - Path to the `runbook.mdx` file

## What It Does

When you run `runbooks serve`:

1. **Starts the Backend Server** - Launches a Go-based HTTP server on port 7825
2. **Serves the API** - Provides REST endpoints for the frontend to call
3. **Does NOT Open Browser** - You must manually navigate to `http://localhost:7825` or run the frontend separately

## When to Use This Command

The `serve` command is intended for **development purposes only**:

### Frontend Development
When working on the React frontend, you typically run two separate processes:

Terminal 1 - Backend:
```bash
runbooks serve ./testdata/demo-runbook-1/runbook.mdx
```

Terminal 2 - Frontend:
```bash
cd web
bun dev
```

This setup allows you to:
- Make changes to React components and see hot-reloading
- Keep the backend running to process API requests
- Debug frontend and backend separately

### When NOT to Use This

**For regular runbook usage**, use `runbooks open` instead. The `serve` command is not intended for runbook authors or consumers - only for developers working on the Runbooks tool itself.s

## Technical Details

### Port
The server runs on **port 7825** by default (not currently configurable via flags).

### CORS
The server is configured to allow CORS requests from the Vite dev server during development.

### Frontend Assets
In production, the server serves the compiled React app from the `/web/dist` directory. During development, you typically run Vite separately on port 5173.

## Development Workflow

A typical development workflow:

1. Start the backend:
   ```bash
   runbooks serve ./testdata/demo-runbook-1/runbook.mdx
   ```

2. In another terminal, start the frontend:
   ```bash
   cd web
   bun dev
   ```

3. Open your browser to `http://localhost:5173` (Vite's port)

4. Make changes to:
   - React code in `/web/src` - hot reloads automatically
   - Go code - restart the `serve` command
   - Runbook files - refresh the browser

## See Also

- [`runbooks open`](/commands/open) - The command for regular runbook usage

