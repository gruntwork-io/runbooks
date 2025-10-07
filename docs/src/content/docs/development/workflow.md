---
title: Development Workflow
---

If you're developing the Runbooks tool itself (working on the Go backend or React frontend), you'll want to run two separate processes in different terminals:

**Terminal 1 - Backend Server:**
```bash
go run main.go serve testdata/demo-runbook-1/runbook.mdx
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
go run main.go serve testdata/demo-runbook-1/runbook.mdx
go run main.go serve testdata/demo-runbook-2/runbook.mdx
go run main.go serve testdata/runbook-with-boilerplate/runbook/runbook.mdx
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

## Tips for Runbook Authors

### Use Relative Paths

Always reference files relative to your runbook:

```mdx
<Check path="checks/prereq.sh" ... />
<BoilerplateInputs templatePath="templates/my-template" ... />
![Diagram](./assets/diagram.png)
```

### Organize Your Files

Keep your runbook directory organized:

```
my-runbook/
├── runbook.mdx
├── checks/       # Validation scripts
├── scripts/      # Command scripts
├── templates/    # Boilerplate templates
└── assets/       # Images, diagrams
```

### Test Commands Independently

Before adding commands to your runbook, test them in your terminal to make sure they work.

### Use Version Control

Keep your runbooks in Git to track changes and collaborate with others.

### Start Simple

Begin with a simple runbook and add complexity gradually. Test each block as you add it.
