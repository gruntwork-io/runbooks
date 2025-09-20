It is critical that you ignore this prompt for now. This is only a to-do, and this is something I will handle later, not something I want to handle right now.

# LLM Prompt: Implement Runbooks Watch Command

Use this prompt to implement the watch command functionality for the runbooks tool.

## Context

I have a runbooks tool with three types of users:

1. **Runbook Developers** (me) - manually start Vite dev server for development
2. **Runbook Authors** - use `runbooks watch` for live updates while writing runbooks
3. **Runbook Consumers** - use `runbooks open` for efficient static rendering

## Current State

- `runbooks open` command serves static files from `http/dist/` for consumers
- `runbooks watch` command exists but is just a placeholder
- Need to implement file watching and live reload functionality

## Requirements

### For `runbooks watch` command:
1. **File Watching**: Watch the specified runbook file/directory for changes using `fsnotify`
2. **Live Reload**: When files change, automatically refresh the browser or trigger a reload
3. **Development Server**: Serve the built files from `http/dist/` with live reload capabilities
4. **Browser Integration**: Open browser and keep it in sync with file changes

### Implementation Details Needed:

1. **Add fsnotify dependency**:
   ```bash
   go get github.com/fsnotify/fsnotify
   ```

2. **Update `cmd/watch.go`**:
   - Add proper imports (fsnotify, gin, etc.)
   - Implement `watchRunbook(path string)` function
   - Add file watcher that monitors the specified path
   - Implement `startDevServerWithReload()` function
   - Add `triggerBrowserReload()` function
   - Handle file change events and trigger reloads

3. **Key Functions to Implement**:
   ```go
   func watchRunbook(path string) {
       // Start dev server with reload capability
       // Open browser
       // Set up file watcher
       // Handle file change events
   }
   
   func startDevServerWithReload() {
       // Serve static files from http/dist/
       // Add /reload endpoint for live updates
       // Handle SPA routing
   }
   
   func triggerBrowserReload() {
       // Send reload signal to browser
       // Could use WebSocket or Server-Sent Events for advanced reload
   }
   ```

4. **File Watching Logic**:
   - Use `fsnotify.NewWatcher()` to create file watcher
   - Add the runbook path to the watcher
   - Listen for `fsnotify.Write` events
   - Trigger browser reload when files change

5. **Error Handling**:
   - Check if `http/dist/` directory exists
   - Handle file watcher errors gracefully
   - Provide clear error messages for missing dependencies

## Expected Behavior

- `runbooks watch testdata/markdown-only-simple/` should:
  1. Start a development server on localhost:7825
  2. Open browser to the server
  3. Watch the specified path for file changes
  4. Automatically reload the browser when files are modified
  5. Provide clear logging about what's being watched and when changes occur

## Dependencies to Add

- `github.com/fsnotify/fsnotify` for file watching
- Ensure `gin` is available for the development server

## Testing

After implementation, test with:
```bash
# Build the tool
go build -o runbooks .

# Test watch command
./runbooks watch testdata/markdown-only-simple/

# In another terminal, modify the runbook file and verify browser reloads
```

## Notes

- The watch command should serve the same static files as the open command
- Focus on simplicity - basic file watching and reload is sufficient
- Can be enhanced later with WebSocket-based live reload for better UX
- Make sure to handle cleanup properly when the command is interrupted
