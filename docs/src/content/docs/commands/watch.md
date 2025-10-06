---
title: watch
---

# `runbooks watch`

Opens a runbook in your browser and automatically reloads it when you make changes to the runbook file. This command is perfect for runbook authors who want to see their edits in real-time.

## Usage

```bash
runbooks watch <path-to-runbook>
```

## Arguments

- `<path-to-runbook>` - Path to a `runbook.mdx` file

## What It Does

When you run `runbooks watch`:

1. **Starts the Backend Server** - Launches a Go-based HTTP server on port 7825
2. **Opens Your Browser** - Automatically navigates to `http://localhost:7825`
3. **Watches for Changes** - Monitors the runbook file for any modifications
4. **Auto-Reloads** - Automatically refreshes the browser when changes are detected (within ~300ms)

## When to Use This Command

The `watch` command is designed for **runbook authors** who are actively writing or editing runbooks.

### Writing a New Runbook

```bash
runbooks watch ./my-runbook/runbook.mdx
```

Then in your editor:
1. Make changes to `runbook.mdx`
2. Save the file
3. See your changes instantly in the browser - no manual refresh needed!

### Iterating on Content

The `watch` command is particularly useful when you're:
- **Writing documentation** - See how your Markdown formatting looks
- **Refining instructions** - Quickly preview changes to step-by-step instructions
- **Testing boilerplate templates** - Verify that your templating works correctly
- **Adjusting layout** - Fine-tune how your runbook appears to users
- **Debugging issues** - Quickly test fixes to syntax or formatting problems

## Technical Details

### Port
The server runs on **port 7825** by default (not currently configurable via flags).

### File Watching
- Uses `fsnotify` for efficient file system monitoring
- Watches the directory containing your runbook file
- Implements debouncing (300ms) to handle editors that save files multiple times
- Only triggers on Write and Create events for your specific runbook file

### Auto-Reload Mechanism
- Uses Server-Sent Events (SSE) to push notifications from server to browser
- The browser maintains a persistent connection to `/api/watch/sse`
- When the file changes, the server sends a `file-change` event
- The browser receives the event and automatically reloads the page

