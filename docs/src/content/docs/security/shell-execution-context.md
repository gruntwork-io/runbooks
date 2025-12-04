---
title: Shell Execution Context
description: Understanding how Runbooks executes scripts in a non-interactive shell
---

Scripts executed by Runbooks in [Check](/authoring/blocks/check) or [Command](/authoring/blocks/command) blocks run in a **non-interactive shell**. This has important implications for what works and what doesn't.

## What's Available

| Feature | Available? | Notes |
|---------|------------|-------|
| Environment variables | ✅ Yes | Inherited from the process that launched Runbooks |
| Binaries in `$PATH` | ✅ Yes | `git`, `aws`, `terraform`, etc. |
| Shell aliases | ❌ No | `ll`, `la`, custom aliases |
| Shell functions | ❌ No | `nvm`, `rvm`, `assume`, etc. |
| RC files | ❌ No | `.bashrc`, `.zshrc` are NOT sourced |

## Example: Aliases vs Binaries

```bash
# ❌ Will NOT work - ll is typically a bash alias for "ls -l"
<Check command="ll" ... />

# ✅ Will work - ls is an actual binary
<Check command="ls -l" ... />
```

## Why This Matters

Many developer tools are implemented as **shell functions** rather than standalone binaries. These functions are often defined in your shell's RC files (`.bashrc`, `.zshrc`) and only exist in interactive shell sessions.

Common tools that are shell functions (not binaries):
- **nvm** — Node Version Manager
- **rvm** — Ruby Version Manager  
- **pyenv** shell integration
- **conda activate**
- **assume** — Shell function from [Granted](https://docs.commonfate.io/granted/introduction)

These tools need to be shell functions because they modify your current shell's environment (e.g., changing `$PATH` or setting environment variables), which can't be done from a subprocess.

## Workarounds

For tools that are shell functions, instead of invoking them directly, you can check for the underlying installation instead:

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

If you absolutely need shell functions, you can source the RC file in your script that runs in the Check or Command block (use with caution):

```bash
#!/bin/bash
# Source shell config to get functions (not recommended for portability)
source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null

# Now nvm should be available
nvm --version
```

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

