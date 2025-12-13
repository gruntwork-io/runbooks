---
title: Execution Security Model
description: Understanding how Runbooks validates and executes scripts in different modes
---

## Overview

Runbooks executes commands and shell scripts defined your Runbook directly on your local computer with the full set of environment variables present when you launched the Runbooks binary. This is a mandate to take security seriously, and in this section we'll discuss the security measures Runbooks takes to protect users.

## Security measures

Runbooks implements specific techniques to make sure that you only execute "approved" code:

### Warning to only run Runbooks you trust

When Runbooks loads, it immediately shows a warning to users to confirm that they trust the Runbook they just opened. This warning will show on every Runbook you open until permanently hide it.

### Localhost-Only Binding for the API

The Runbooks backend server (which runs locally on your computer) only accepts connections from `localhost` (127.0.0.1). This prevents remote attacks where a malicious website could send requests to your local Runbooks server.

### Executable Registry

By default, Runbooks uses an **executable registry,** which is a _registry_ of all _executable_ artifacts, to make sure that the backend server will only allow execution of scripts and commands defined directly in the Runbook you opened (versus running arbitrary scripts).

Here's how it works. When a user runs `runbooks open`, `runbooks watch`, or `runbooks serve`, Runbooks starts the backend server and populates the executable registry with all scripts or commands contained in the Runbook. To populate the executable registry, Runbooks reads your `runbook.mdx` file and scans for all `<Check>` and `<Command>` components. For each component, it extracts the script (either from the `command` prop for inline scripts or by reading the file specified in the `path` prop), assigns it a unique executable ID, and stores it in an in-memory registry. The registry maps each executable ID to its corresponding script content, component ID, and metadata like template variables.

When you click "Run" in the UI, the frontend sends an execution request containing only the executable ID and any template variable values, but _not the actual script content_. The backend validates that this executable ID exists in the registry (which was built from your Runbook at startup), retrieves the pre-approved script content, renders it with the given variables if needed, and executes it. This means even if an attacker could manipulate API requests, they cannot inject arbitrary code because the backend will only execute scripts that were present in your Runbook when the server started. Effectively, the registry acts as a whitelist of approved executables.

## Execution Modes

Runbooks has three execution modes with different security/convenience trade-offs:

1. Open/Serve (Executable Registry)
2. Watch (Live-File-Reload, default)
3. Watch with `--disable-live-file-reload` (Executable Registry)

### Open and Serve Modes
```bash
runbooks open path/to/runbook.mdx
runbooks serve path/to/runbook.mdx
```

**When to use:**
- Use `runbooks open` for Runbook consumers who want to guarantee that they are executing exactly what the Runbook author wrote.
- Use `runbooks serve` for Runbook developers who want to manually run the frontend and don't need hot reloading of executables.

**How it works:**
1. Server starts and scans the runbook file
2. Builds an **Executable Registry** containing all `<Check>` and `<Command>` components
3. Assigns each script a unique ID
4. At execution time, validates the ID exists in the registry
5. Executes only pre-approved scripts

**Security:** High
- All scripts pre-validated at startup
- Cannot execute arbitrary code via API manipulation
- Changes to scripts require server restart

**Convenience:** Medium
- When you make local file changes, the Runbook will not honor them automatically; you'll need to re-open the runbook to "activate" any new file changes.

### Watch (Default: Live-File-Reload)
```bash
runbooks watch path/to/runbook.mdx
```

**When to use:**
- Use `runbooks watch` (the default) for Runbook authors who want to auto-reload their runbook file _and_ all Runbook script files. Since they are actively editing files on their file system, they are presumably ok with having these hot-reloaded.

**How it works:**
1. Server starts _without building an executable registry_
2. Watches the Runbook file for changes and automatically reloads the UI
3. When user clicks "Run" on a script:
   - Backend reads the runbook file _from disk at that moment_
   - Parses the file to find the requested component
   - Extracts and executes the script content _from the current file system state_
4. Essentially, every execution reads fresh from disk

**Security:** Medium
- No pre-validation of scripts at startup
- Scripts read from current file system state
- Still protected by localhost-only binding
- More vulnerable to file system manipulation

**Convenience:** High
- Script changes take effect immediately
- No server restart needed
- Perfect for rapid runbook development

### Watch with `--disable-live-file-reload`
```bash
runbooks watch --disable-live-file-reload path/to/runbook.mdx
```

**When to use:**
- Use `runbooks watch --disable-live-file-reload` if you want the extra security of executable registry validation while authoring runbooks, but be aware of the confusing UX where displayed scripts don't match executed scripts until server restart.

**How it works:**
1. Same as Open/Serve mode (uses Executable Registry)
2. Watches the Runbook file for changes
3. When the Runbook file does change, the frontend UI automatically reloads, but the executable registry does _not_ update.
4. All scripts -- including inline scripts -- are validated against the registry from startup.

For example, if the Runbook content changes to include an updated inline script, the Runbook will reload and display the new script text, but the Executable Registry will not update. Until you restart the server, clicking "Run" will execute the _old_ script!

**Security:** High
- Same security as Open/Serve mode
- File watching doesn't affect execution validation

**Convenience:** Low
- MDX content updates automatically
- Script changes require server restart (confusing UX)

## How Scripts Are Executed

Regardless of mode, the actual execution process is:

1. **Validate request**: Check that execution is authorized (via registry or on-demand parsing)
2. **Render templates**: If script contains template variables like `{{ .VarName }}`, substitute them
3. **Create temp file**: Write script content to a temporary file
4. **Make executable**: Set file permissions (`chmod 0700`)
5. **Detect interpreter**: Read shebang line (e.g., `#!/bin/bash`) or default to `bash`
6. **Execute**: Run script with detected interpreter in a non-interactive shell
7. **Stream output**: Send stdout/stderr back to browser via Server-Sent Events (SSE)
8. **Clean up**: Delete temporary file

**Security note:** Scripts run with your user's full environment variables and permissions. Runbooks is designed for **trusted runbooks only** - it's meant to streamline tasks you would otherwise run manually in your terminal.

For details on interpreter detection and shell limitations (aliases, functions, RC files), see [Shell Execution Context](/security/shell-execution-context/).
