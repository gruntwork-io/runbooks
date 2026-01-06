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

### Multiple Browser Tabs

If you open the same runbook in multiple browser tabs, they all share the same environment. Changes made in one tab are visible in all others — like having multiple terminal windows connected to the same shell session.

### Implementation Notes

The Runbooks server maintains a single session per runbook instance. Each script execution captures environment changes and working directory updates, then applies them to the session state. This happens automatically — you don't need to do anything special in your scripts.

The session resets when you restart the Runbooks server. You can also manually reset the environment to its initial state using the session controls in the UI.

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
