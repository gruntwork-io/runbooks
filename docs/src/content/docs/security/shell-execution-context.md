---
title: Shell Execution Context
description: Understanding how Runbooks executes scripts and maintains environment state
---

## Persistent Environment Model

**Think of Runbooks like a persistent terminal session.** When you run scripts in Check or Command blocks, environment changes carry forward to subsequent blocks — just like typing commands in a terminal.

| What persists | Example |
|---------------|---------|
| Environment variables | `export AWS_PROFILE=prod` stays set for later blocks |
| Working directory | `cd /path/to/project` changes where later scripts run |
| Unset variables | `unset DEBUG` removes the variable for later blocks |

This means you can structure your runbook like a workflow:

1. **Block 1**: Set up environment (`export AWS_REGION=us-east-1`)
2. **Block 2**: Run a command that uses `$AWS_REGION`
3. **Block 3**: Clean up (`unset AWS_REGION`)

### Bash Scripts Only

:::caution[Environment persistence requires Bash]
Environment variable changes **only persist for Bash scripts** (`#!/bin/bash` or `#!/bin/sh`). Non-Bash scripts like Python, Ruby, or Node.js can **read** environment variables from the session, but changes they make (e.g., `os.environ["VAR"] = "value"` in Python) will **not** persist to subsequent blocks.
:::

| Script Type | Can read env vars | Can set persistent env vars |
|-------------|-------------------|----------------------------|
| Bash (`#!/bin/bash`) | ✅ Yes | ✅ Yes |
| Sh (`#!/bin/sh`) | ✅ Yes | ✅ Yes |
| Python (`#!/usr/bin/env python3`) | ✅ Yes | ❌ No |
| Ruby (`#!/usr/bin/env ruby`) | ✅ Yes | ❌ No |
| Node.js (`#!/usr/bin/env node`) | ✅ Yes | ❌ No |
| Other interpreters | ✅ Yes | ❌ No |

**Why?** Environment persistence works by wrapping your script in a Bash wrapper that captures environment changes after execution. This wrapper is Bash-specific and can't be applied to other interpreters. Additionally, environment changes in subprocesses (like a Python script) can't propagate back to the parent process — this is a fundamental limitation of how Unix processes work.

### Multiline Environment Variables

Environment variables can contain embedded newlines — RSA keys, JSON configs, multiline strings, etc. These values are correctly preserved across blocks:

```bash
#!/bin/bash
export SSH_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
-----END RSA PRIVATE KEY-----"

export JSON_CONFIG='{
  "database": "postgres",
  "settings": { "timeout": 30 }
}'
```

Runbooks uses NUL-terminated output (`env -0`) when capturing environment variables, which correctly handles values containing newlines. This works on Linux, macOS, and Windows with Git Bash.

### User Trap Support

Your scripts can optionally use `trap` commands for cleanup.

```bash
#!/bin/bash
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Your script logic...
export RESULT="computed value"
```

Runbooks intercepts EXIT traps to ensure both your cleanup code **and** environment capture (capturing the environment variables that were set in this script and making those values available to other scripts) run correctly. When your script exits:

1. Your trap handler runs first (cleanup happens)
2. Runbooks captures the final environment state
3. The original exit code is preserved

This means you can write scripts with proper cleanup logic and still have environment changes persist to subsequent blocks.

### Multiple Browser Tabs

If you open the same runbook in multiple browser tabs, they all share the same environment. Changes made in one tab are visible in all others — like having multiple terminal windows connected to the same shell session.

### Concurrent Script Execution

:::caution[Environment changes may be lost when scripts run concurrently]
If you run multiple scripts at the same time (for example, clicking "Run" on two different blocks before the first completes), environment changes from one script may silently overwrite changes from the other.
:::

**Why this happens:** When a script starts, it captures the current environment as a snapshot. When it finishes, it replaces the session environment with whatever the script ended with. If two scripts run concurrently:

1. Script A and Script B both start with environment `{X=1}`
2. Script A sets `X=2`
3. Script B sets `Y=3`
4. Whichever finishes last overwrites the other's changes

For example, if Script B finishes last, the session ends up with `{X=1, Y=3}` — losing Script A's change to `X`.

**Recommendation:** If your scripts depend on environment changes from previous scripts, wait for each script to complete before running the next one. The environment model is designed for sequential, step-by-step execution, similar to typing commands in a terminal one at a time.

### Implementation Notes

The Runbooks server maintains a single session per runbook instance. Each script execution captures environment changes and working directory updates, then applies them to the session state. This happens automatically — you don't need to do anything special in your scripts.

The session resets when you restart the Runbooks server. You can also manually reset the environment to its initial state using the session controls in the UI.

---

## Built-in Environment Variables

Runbooks exposes the following environment variables to all scripts:

| Variable | Description |
|----------|-------------|
| `GENERATED_FILES` | Path to a temporary directory where scripts can write files to be captured. Files written here appear in the **Generated** tab after successful execution. |
| `WORKTREE_FILES` | Path to the active git worktree (set by the most recent `<GitClone>` block). Scripts can modify cloned repo files directly through this path. **Unset** if no repo has been cloned. |
| `RUNBOOK_FILES` | Backward-compatible alias for `GENERATED_FILES`. Prefer `GENERATED_FILES` in new scripts. |

### Capturing Output Files

To save files to the generated files directory, write them to `$GENERATED_FILES`:

```bash
#!/bin/bash
# Generate a config and capture it
tofu output -json > "$GENERATED_FILES/outputs.json"

# Create subdirectories as needed
mkdir -p "$GENERATED_FILES/config"
echo '{"env": "production"}' > "$GENERATED_FILES/config/settings.json"
```

Files are only captured after successful execution (exit code 0 or 2). If your script fails, any files written to `$GENERATED_FILES` are discarded.

See [Capturing Output Files](/authoring/blocks/command/#capturing-output-files) for more details.

### Modifying Cloned Repositories

If a `<GitClone>` block has cloned a repository, use `$WORKTREE_FILES` to modify files in the cloned repo:

```bash
#!/bin/bash
if [ -n "${WORKTREE_FILES:-}" ]; then
    echo "Modifying files in cloned repo: $WORKTREE_FILES"
    echo "new config" >> "$WORKTREE_FILES/settings.hcl"
else
    echo "No git worktree available"
fi
```

Unlike `$GENERATED_FILES`, writes to `$WORKTREE_FILES` happen directly on the filesystem — they are not captured to a temporary directory. Changes show up in the **Changed** tab via `git diff`.

---

## Non-Interactive Shell

Scripts run in a **non-interactive shell**, which affects what's available:

| Feature | Available? | Notes |
|---------|------------|-------|
| Environment variables | ✅ Yes | Inherited from Runbooks + changes from previous blocks |
| Binaries in `$PATH` | ✅ Yes | `git`, `aws`, `terraform`, etc. |
| Shell aliases | ❌ No | `ll`, `la`, custom aliases |
| Shell functions | ❌ No | `nvm`, `rvm`, `assume`, etc. |
| RC files | ❌ No | `.bashrc`, `.zshrc` are NOT sourced |

### Example: Aliases vs Binaries

```bash
# ❌ Will NOT work - ll is typically a bash alias for "ls -l"
<Check command="ll" ... />

# ✅ Will work - ls is an actual binary
<Check command="ls -l" ... />
```

### Why This Matters

Many developer tools are implemented as **shell functions** rather than standalone binaries. These functions are defined in your shell's RC files (`.bashrc`, `.zshrc`) and only exist in interactive shell sessions.

Common tools that are shell functions (not binaries):
- **nvm** — Node Version Manager
- **rvm** — Ruby Version Manager  
- **pyenv** shell integration
- **conda activate**
- **assume** — Shell function from [Granted](https://docs.commonfate.io/granted/introduction)

These tools need to be shell functions because they modify your current shell's environment (e.g., changing `$PATH`), which can't be done from a subprocess.

### Workarounds

For tools that are shell functions, check for the underlying installation instead:

```bash
#!/bin/bash
# Instead of running "nvm --version" (won't work), check if nvm is installed:
if [ -d "$HOME/.nvm" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
    echo "✅ nvm is installed"
    exit 0
else
    echo "❌ nvm is not installed"
    exit 1
fi
```

If you absolutely need shell functions, source the RC file in your script (use with caution):

```bash
#!/bin/bash
# Source shell config to get functions (not recommended for portability)
source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null

# Now nvm should be available
nvm --version
```

---

## Interpreter Detection

Runbooks determines which interpreter to use for your script:

1. **Shebang line** — If your script starts with `#!/bin/bash`, `#!/usr/bin/env python3`, etc., that interpreter is used
2. **Default** — If no shebang is present, `bash` is used

### Common Shebangs

| Shebang | Interpreter |
|---------|-------------|
| `#!/bin/bash` | Bash shell |
| `#!/bin/zsh` | Zsh shell |
| `#!/usr/bin/env python3` | Python 3 |
| `#!/usr/bin/env node` | Node.js |

### Best Practice

Always include a shebang in your scripts to ensure predictable execution:

```bash
#!/bin/bash
set -e
# Your script here...
```

---

## Demo Runbooks

The Runbooks repository includes demo runbooks that showcase these execution features:

### Persistent Environment Demo

The [`runbook-execution-model`](https://github.com/gruntwork-io/runbooks/tree/main/testdata/feature-demos/runbook-execution-model) demo demonstrates:

- Setting and reading environment variables across blocks
- Working directory persistence
- Multiline environment variables (RSA keys, JSON)
- Non-bash scripts reading (but not setting) persistent env vars

### File Capture Demo

The [`capture-files-from-scripts`](https://github.com/gruntwork-io/runbooks/tree/main/testdata/feature-demos/capture-files-from-scripts) demo demonstrates:

- Using `$GENERATED_FILES` to capture generated files
- Combining environment persistence with file generation
- Creating OpenTofu configs from environment variables set in earlier blocks
