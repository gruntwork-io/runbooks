---
title: Development Workflow
---

If you're developing the Runbooks tool itself (working on the Go backend or React frontend), you'll want to run two separate processes in different terminals:

**Terminal 1 - Backend Server:**
```bash
go run main.go serve testdata/sample-runbooks/demo1/runbook.mdx
```

This starts the Go backend API server on port 7825.

**Terminal 2 - Frontend Dev Server:**
```bash
cd web
bun dev
```

This starts the Vite dev server on port 5173 with hot-reloading.

### Making Changes

**Frontend Changes (React/TypeScript):**
- Edit files in `/web/src`
- Vite automatically hot-reloads the browser
- No restart needed

**Backend Changes (Go):**
- Edit files in `/api`, `/cmd`, etc.
- Restart the `serve` command (Ctrl+C and run again)
- Refresh the browser

**Runbook Changes:**
- Edit the runbook file you're testing with
- Refresh the browser
- No restart needed

### Testing Your Changes

Test different runbook features:

```bash
# Test with different demo runbooks
go run main.go serve testdata/sample-runbooks/demo1/runbook.mdx
go run main.go serve testdata/sample-runbooks/demo2/runbook.mdx
go run main.go serve testdata/test-fixtures/runbooks/with-boilerplate/runbook/runbook.mdx
```

### Building for Production

Build the frontend assets:
```bash
cd web
bun run build
```

This creates optimized files in `/web/dist` that are served by the Go backend in production.

Build the Go binary:
```bash
go build -o runbooks main.go
```

### Running Tests

Run Go tests:
```bash
go test ./...
```

Run frontend tests:
```bash
cd web
bun test
```

## Adding shadcn/ui Components

This project uses [shadcn/ui](https://ui.shadcn.com/) for UI components.

To add a new component:

```bash
cd web
bunx shadcn@latest add <component-name>
```

For example:
```bash
bunx shadcn@latest add dialog
bunx shadcn@latest add dropdown-menu
```

Components are added to `/web/src/components/ui/`.
