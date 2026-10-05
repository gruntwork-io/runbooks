---
title: Shell execution context
description: How Runbooks runs scripts and keeps environment state between blocks
---

## Environment persists between blocks

Scripts in Check and Command blocks share one session. When a Bash script exits with code 0 or 2, Runbooks applies its environment changes to the session, and later blocks see them.

| What persists | Example |
|---------------|---------|
| Environment variables | `export AWS_PROFILE=prod` stays set for later blocks |
| Working directory | `cd /path/to/project` changes where later scripts run |
| Unset variables | `unset DEBUG` removes the variable for later blocks |

Changes made by a script that exits with any other code, times out or is cancelled are discarded.

### Bash scripts only

:::caution[Environment persistence requires Bash]
Only scripts with a `#!/bin/bash` or `#!/bin/sh` shebang, or no shebang, can change the session. Scripts in other languages can read the session's environment variables, but a change such as `os.environ["VAR"] = "value"` in Python does not reach later blocks.
:::

| Script type | Can read env vars | Can set persistent env vars |
|-------------|-------------------|-----------------------------|
| Bash (`#!/bin/bash`) | Yes | Yes |
| Sh (`#!/bin/sh`) | Yes | Yes |
| Python (`#!/usr/bin/env python3`) | Yes | No |
| Ruby (`#!/usr/bin/env ruby`) | Yes | No |
| Node.js (`#!/usr/bin/env node`) | Yes | No |
| Other interpreters | Yes | No |

Runbooks wraps each Bash script in Bash code that writes the environment and working directory to temporary files when the script exits. That wrapper cannot run under another interpreter, and a child process cannot change its parent's environment.

Because the wrapper is Bash code, scripts with a `#!/bin/sh` shebang run under `bash`. On Debian and Ubuntu, `sh` is `dash`, which can't run the wrapper. Bash runs POSIX `sh` scripts as they are. For `#!/bin/sh` scripts Runbooks also turns on Bash's `xpg_echo` option, so `echo "a\nb"` prints two lines, as `sh` does on macOS, Debian and Ubuntu. Scripts with a `#!/bin/bash` shebang keep Bash's default, where `echo` prints `\n` literally unless you pass `-e`.

### Multiline environment variables

Values with embedded newlines, such as RSA keys and JSON, persist across blocks unchanged. Runbooks captures the environment with NUL-terminated output (`env -0`).

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

### `trap` handlers

Scripts can set their own `EXIT` trap for cleanup.

```bash
#!/bin/bash
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Your script logic...
export RESULT="computed value"
```

Runbooks captures the environment in its own `EXIT` handler, so it intercepts `trap` calls that name `EXIT` and saves your handler. The usual `trap` forms all work: `trap -- cleanup EXIT`, `trap cleanup INT EXIT` (the `INT` handler is installed as usual), and resets such as `trap - EXIT` or `trap EXIT`. When your script exits:

1. Your trap handler runs.
2. Runbooks captures the environment and working directory.
3. The script exits with its original exit code.

### One session per runbook

The app has one window and one session. Every script in a runbook shares it. The session lasts until you open a different runbook or quit the app.

### Starting environment

The session starts from the environment the Runbooks app was started with.

If you start Runbooks from a terminal or an SSH session, it uses that terminal's environment as it is. A variable you set on the command line that starts Runbooks, such as `AWS_PROFILE=prod`, is the value your scripts see.

If you start Runbooks from Finder, the Dock or a desktop launcher on macOS or Linux, it first runs your login shell once as `$SHELL -ilc` and copies the environment that shell ends up with. Because the shell is both a login and an interactive shell, it reads your profile and rc files, so your `PATH` and the variables they export are available to scripts.

On Windows, Runbooks uses the environment it was started with.

### How script changes are applied

When a Bash script exits with code 0 or 2, Runbooks applies only what that script changed:

- Variables the script exported or changed are set to their new values.
- Variables the script unset are removed from the session.
- The working directory changes only if the script changed directory.

Everything else in the session is left as it is. If the session changed while the script was running, for example because an auth block added credentials, those changes are kept and the script's changes are applied on top of them. If the script and something else both changed the same variable, the script's value wins.

If you open a different runbook while a script is running, the finished script's changes are discarded. The same applies to a sign-in or a `<GitClone>` still in progress when you switch: its credentials and checkout are not added to the new runbook's session. Sign in or clone again from the new runbook.

### Running scripts at the same time

You can click Run on a block while another block's script is still going, and both keep running. Runbooks holds a block back when it can tell the block has to wait: the block uses the outputs of a block that is running, names a block in `dependsOn` that hasn't succeeded, or would overlap with an `exclusive` block. See [Run order](/authoring/blocks/command/#run-order).

Runbooks can't tell that one script reads a variable or a directory another script sets. A script gets the session as it stood when you clicked Run, and Runbooks applies its changes when it finishes, so two scripts running together don't see each other's changes. If a script needs what an earlier block exported, name the earlier block in its `dependsOn`. When overlapping scripts set the same variable, or both change directory, the last one to finish wins.

Runbooks discards the environment changes of a script you stop.

## Built-in environment variables

Runbooks sets the following environment variables for every script:

| Variable | Description |
|----------|-------------|
| `GENERATED_FILES` | Path to a temporary directory where scripts can write files to be captured. Files written here appear in the **Generated files** tab when the script exits with code 0 or 2. |
| `REPO_FILES` | Path to the active git worktree: the one you selected in the workspace, or the most recently registered one if you selected none. Unset if no repository has been cloned. |
| `RUNBOOK_OUTPUT` | Path to a file where scripts can write `key=value` pairs to produce [block outputs](/authoring/blocks/command/#block-outputs) for later blocks. Write `sensitive:key=value` to mask a credential in the UI (see [Sensitive outputs](/authoring/inputs-and-outputs/#sensitive-outputs)). |

Each script also gets log files. The `log_info`, `log_warn`, `log_error` and `log_debug` functions append to `RUNBOOK_LOG`, and each of their lines names its level. `RUNBOOK_INFO_LOG`, `RUNBOOK_WARN_LOG`, `RUNBOOK_ERROR_LOG` and `RUNBOOK_DEBUG_LOG` take lines that don't name a level, which show up at the file's level. Any command or script can append to them all, and their lines appear in the block's logs as the script writes them. The files are deleted when the run ends. See [Log files](/authoring/blocks/command/#log-files).

### Capturing output files

Write files to `$GENERATED_FILES` to save them to the generated files directory:

```bash
#!/bin/bash
# Generate a config and capture it
tofu output -json > "$GENERATED_FILES/outputs.json"

# Create subdirectories as needed
mkdir -p "$GENERATED_FILES/config"
echo '{"env": "production"}' > "$GENERATED_FILES/config/settings.json"
```

Files are captured only when the script exits with code 0 or 2. If the script fails, files written to `$GENERATED_FILES` are discarded.

See [Capturing output files](/authoring/blocks/command/#capturing-output-files) for more.

### Modifying cloned repositories

If a `<GitClone>` block has cloned a repository, use `$REPO_FILES` to modify files in it:

```bash
#!/bin/bash
if [ -n "${REPO_FILES:-}" ]; then
    echo "Modifying files in cloned repo: $REPO_FILES"
    echo "new config" >> "$REPO_FILES/settings.hcl"
else
    echo "No git worktree available"
fi
```

Writes to `$REPO_FILES` go straight to the checkout on disk, whatever the script's exit code. They show up in the **Changed files** tab.

## Non-interactive shell

Scripts run in a non-interactive shell, which limits what they can use:

| Feature | Available | Notes |
|---------|-----------|-------|
| Environment variables | Yes | The session's environment, including changes from earlier blocks |
| Binaries in `$PATH` | Yes | `git`, `aws`, `tofu` and so on |
| Shell aliases | No | `ll`, `la`, custom aliases |
| Shell functions | No | `nvm`, `rvm`, `assume` and so on |
| RC files | No | Scripts do not source `.bashrc` or `.zshrc`. On a desktop launch Runbooks reads them once at startup for exported variables only (see [Starting environment](#starting-environment)). |

### Aliases and binaries

```bash
# Fails: ll is usually a shell alias for "ls -l"
<Check command="ll" ... />

# Works: ls is a binary
<Check command="ls -l" ... />
```

### Tools that are shell functions

Some developer tools are shell functions defined in your rc files (`.bashrc`, `.zshrc`), so they exist only in interactive shells:

- `nvm`, Node Version Manager
- `rvm`, Ruby Version Manager
- `pyenv` shell integration
- `conda activate`
- `assume`, from [Granted](https://docs.commonfate.io/granted/introduction)

They are functions because they change the current shell's environment, such as `$PATH`, which a child process cannot do.

### Workarounds

For a tool that is a shell function, check for its installation:

```bash
#!/bin/bash
# "nvm --version" fails here, so check that nvm is installed
if [ -d "$HOME/.nvm" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
    echo "nvm is installed"
    exit 0
else
    echo "nvm is not installed"
    exit 1
fi
```

If a script needs the function itself, source the rc file in the script. This ties the script to one shell's configuration.

```bash
#!/bin/bash
source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null

nvm --version
```

## Interpreter detection

If a script starts with a shebang such as `#!/bin/bash` or `#!/usr/bin/env python3`, Runbooks runs it with that interpreter. Without a shebang it uses `bash`.

| Shebang | Interpreter |
|---------|-------------|
| `#!/bin/bash` | Bash |
| `#!/bin/sh` | Bash (see [Bash scripts only](#bash-scripts-only)) |
| `#!/bin/zsh` | Zsh |
| `#!/usr/bin/env python3` | Python 3 |
| `#!/usr/bin/env node` | Node.js |

Start each script with a shebang so the interpreter does not depend on the default:

```bash
#!/bin/bash
set -e
# Your script here...
```

## Demo runbooks

The Runbooks repository has demo runbooks for these features.

[`runbook-execution-model`](https://github.com/gruntwork-io/runbooks/tree/main/testdata/feature-demos/runbook-execution-model) covers environment persistence:

- Setting and reading environment variables across blocks
- Working directory persistence
- Multiline environment variables (RSA keys, JSON)
- Non-Bash scripts reading persistent environment variables

[`capture-files-from-scripts`](https://github.com/gruntwork-io/runbooks/tree/main/testdata/feature-demos/capture-files-from-scripts) covers file capture:

- Using `$GENERATED_FILES` to capture generated files
- Creating OpenTofu configs from environment variables set in earlier blocks

[`file-workspace`](https://github.com/gruntwork-io/runbooks/tree/main/testdata/feature-demos/file-workspace) covers the file workspace:

- Cloning a repository with `<GitClone>` and browsing its files
- Using `$REPO_FILES` to modify files in a cloned repo
- Writing templates directly into a worktree with `target="worktree"`
- Viewing changes in the **Changed files** diff view
