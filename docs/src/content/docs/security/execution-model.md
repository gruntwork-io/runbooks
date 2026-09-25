---
title: Execution Security Model
description: Understanding how Runbooks validates and executes scripts
---

## Overview

Runbooks executes commands and shell scripts defined your Runbook directly on your local computer with the full set of environment variables present when you launched the Runbooks app. This is a mandate to take security seriously, and in this section we'll discuss the security measures Runbooks takes to protect users.

## Security measures

Runbooks implements specific techniques to make sure that you only execute "approved" code:

### Warning to only run Runbooks you trust

When Runbooks loads, it immediately shows a warning to users to confirm that they trust the Runbook they just opened. This warning will show on every Runbook you open until permanently hide it.

### Executable Registry

Runbooks uses an **executable registry,** which is a _registry_ of all _executable_ artifacts, to make sure that the main process will only allow execution of scripts and commands defined directly in the Runbook you opened (versus running arbitrary scripts).

Here's how it works. When you open a runbook, Runbooks starts the main process and populates the executable registry with all scripts or commands contained in the Runbook. To populate the executable registry, Runbooks reads your `runbook.mdx` file and scans for all `<Check>` and `<Command>` components. For each component, it extracts the script (either from the `command` prop for inline scripts or by reading the file specified in the `path` prop), assigns it a unique executable ID, and stores it in an in-memory registry. The registry maps each executable ID to its corresponding script content, component ID, and metadata like template variables.

When you click "Run" in the UI, the renderer sends an execution request containing only the executable ID and any template variable values, but _not the actual script content_. The main process validates that this executable ID exists in the registry (which was built from your Runbook when it was loaded), retrieves the pre-approved script content, renders it with the given variables if needed, and executes it. This means even if an attacker could manipulate IPC messages, they cannot inject arbitrary code because the main process will only execute scripts that were present in your Runbook when it was loaded. Effectively, the registry acts as a whitelist of approved executables.

### Electron Security

Runbooks follows Electron security best practices to maintain strong process isolation:

- **Sandboxed renderer**: The renderer process runs in a sandboxed environment with no direct access to Node.js APIs or the file system.
- **Context isolation**: The renderer and main process communicate exclusively through a `contextBridge`-exposed API, preventing the renderer from accessing internal Node.js or Electron APIs.
- **No `nodeIntegration` in the renderer**: Node.js integration is disabled in the renderer process. All privileged operations (script execution, file system access, environment management) are handled by the main process.
- **Process isolation**: The main process and renderer process run in separate OS-level processes. The renderer cannot directly invoke system calls or spawn child processes.

## When the Registry Is Built

Every script Runbooks runs comes from the executable registry. What changes between the ways you can open a runbook is when the registry is rebuilt from the files on disk.

### Opening a runbook
```bash
runbooks open path/to/runbook.mdx
```

**When to use:**
- For Runbook consumers who want to guarantee that they are executing exactly what the Runbook author wrote.

**How it works:**
1. Main process loads the runbook file
2. Builds an **Executable Registry** containing all `<Check>` and `<Command>` components
3. Assigns each script a unique ID
4. At execution time, validates the ID exists in the registry
5. Executes only pre-approved scripts

**Security:**
- All scripts pre-validated when the runbook is opened
- Cannot execute arbitrary code via IPC manipulation
- Changes you make to the runbook or its scripts afterwards are not executed until you close and reopen the runbook, which builds a new registry

### Watch mode
```bash
runbooks open --watch path/to/runbook.mdx
```

**When to use:**
- For Runbook authors who want the app to reload their runbook as they edit it. Since they are actively editing files on their file system, they are presumably ok with having these changes picked up.

**How it works:**
1. Main process loads the runbook and builds the registry, as above
2. Watches the runbook file for changes and automatically reloads the UI
3. Each reload rebuilds the registry from the runbook file and the scripts it references _as they are on disk at that moment_
4. Execution still goes through the registry: the renderer sends an executable ID, never script content

**Security:**
- Scripts are still only executed from the registry, so IPC manipulation cannot inject arbitrary code
- Whatever is on disk when the runbook reloads becomes approved, so anything that can write to the runbook's files while you work can change what runs

### Freezing the registry
```bash
runbooks open --watch --disable-live-file-reload path/to/runbook.mdx
```

`--disable-live-file-reload` keeps the registry built when the runbook was first opened. Watch mode still reloads what the app shows, but Runbooks keeps executing the scripts that were present at open, and blocks whose script has changed show a "Script changed" warning. Opening a different runbook builds its registry as usual.

## How Scripts Are Executed

The actual execution process is:

1. **Validate request**: Check that the requested executable ID exists in the registry
2. **Render templates**: If script contains template variables like `{{ .VarName }}`, substitute them
3. **Create temp file**: Write script content to a temporary file
4. **Make executable**: Set file permissions (`chmod 0700`)
5. **Detect interpreter**: Read shebang line (e.g., `#!/bin/bash`) or default to `bash`
6. **Execute**: Run script with detected interpreter in a non-interactive shell
7. **Stream output**: Send stdout/stderr back to the renderer via IPC events
8. **Clean up**: Delete temporary file

**Security note:** Scripts run with your user's full environment variables and permissions. Runbooks is designed for **trusted runbooks only** - it's meant to streamline tasks you would otherwise run manually in your terminal.

For details on interpreter detection, shell limitations, and how environment changes persist across script executions, see [Shell Execution Context](/security/shell-execution-context/).
