---
title: Shell execution context
description: How Runbooks runs scripts, and how scripts set variables for later blocks
---

## Setting variables for later blocks

Scripts in Check and Command blocks share one session. A script sets a variable for the blocks after it by appending a line to the file named by `$RUNBOOK_ENV`:

```bash
#!/usr/bin/env bash
echo "AWS_PROFILE=prod" >> "$RUNBOOK_ENV"
```

When the script exits with code 0 or 2, Runbooks reads the file and sets each variable in the session. The lines a script writes are discarded when it exits with any other code, times out or is cancelled.

`export` and `cd` stay inside the script that runs them. A variable a script exports, or a directory it changes to, doesn't reach the next block.

### File format

Each line is `NAME=value`. Runbooks takes the value as written, up to the end of the line: quotes are part of the value, and nothing in it is expanded. When a file sets the same name twice, the later line wins.

For a value with newlines in it, such as an RSA key or JSON, write `NAME<<DELIMITER`, then the value's lines, then a line that is exactly the delimiter:

```bash
#!/usr/bin/env bash
{
  echo "SSH_KEY<<EOF"
  cat ~/.ssh/deploy_key
  echo "EOF"
} >> "$RUNBOOK_ENV"
```

Pick a delimiter that no line of the value matches.

### Values from outside the script

A value the script didn't write itself, such as a PR title, an API response or a command's output, can have a newline in it. Written as `NAME=value`, the text after the newline becomes a line of its own, and that line can set any variable:

```bash
# Unsafe: a title of "Fix typo<newline>AWS_PROFILE=attacker" sets AWS_PROFILE too
echo "PR_TITLE=$TITLE" >> "$RUNBOOK_ENV"
```

Write such a value with a delimiter the value can't contain, such as a random one:

```bash
#!/usr/bin/env bash
set -euo pipefail
delim="EOF_$(openssl rand -hex 8)"
{
  echo "PR_TITLE<<$delim"
  printf '%s\n' "$TITLE"
  echo "$delim"
} >> "$RUNBOOK_ENV"
```

Without `openssl`, `delim="EOF_$RANDOM$RANDOM$RANDOM"` works too.

### Lines Runbooks skips

Runbooks skips a line, and logs it in the block's logs, when:

- it isn't `NAME=value` or `NAME<<DELIMITER`, or its name isn't a variable name
- it names a variable Runbooks sets for every script: `GENERATED_FILES`, `REPO_FILES`, and the names that start with `RUNBOOK_`
- it names a variable that makes programs run code as they start: `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `PS4`, `PROMPT_COMMAND`, `NODE_OPTIONS`, `PYTHONSTARTUP`, `PERL5OPT`, `RUBYOPT`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, and the names that start with `LD_`, `DYLD_` or `BASH_FUNC_`
- its value has a NUL character, which no environment variable can hold

A log line looks like `RUNBOOK_ENV line 3: BASH_ENV makes programs run code as they start, so a script can't set it. The line was ignored.` It names the variable only when the line has a valid name, so a secret written without `NAME=` in front of it doesn't end up in the logs. After 20 skipped lines, Runbooks logs how many more it skipped instead of each one.

A `NAME<<DELIMITER` line with no closing delimiter line skips the rest of the file.

`PATH` is not on the list. A script can add a directory to it for later blocks:

```bash
echo "PATH=$HOME/.local/bin:$PATH" >> "$RUNBOOK_ENV"
```

A script can't remove a variable from the session. Set it to an empty value with `NAME=` instead.

### Any language

`$RUNBOOK_ENV` is a file, so a script in any language can write to it:

```python
#!/usr/bin/env python3
import os

with open(os.environ["RUNBOOK_ENV"], "a") as f:
    f.write("CLUSTER_NAME=prod-east\n")
```

## Working directory

Scripts start in the [session's directory](/commands/sessions/), not in the folder that contains the runbook. `<GitClone>` clones into the same directory by default.

To run a block's script somewhere else, set the block's `workingDir` prop. A relative path is relative to the session's directory. An absolute path, or one that leads out of the session's directory with `..`, works too.

`workingDir` can use the same `{{ .inputs.X }}` and `{{ .outputs.block.key }}` templates as the block's `env`. A `<GitClone>` block's user can change its local path, so name the clone by its `clone_path` output:

```mdx
<GitClone id="clone_infra" prefilledLocalPath="infra" />

<Command
  id="plan"
  workingDir="{{ .outputs.clone_infra.clone_path }}/live/prod"
  command="tofu plan"
/>
```

A template error, such as an output that doesn't exist yet, fails the block with a message that starts with `workingDir:`. The directory must exist when the block runs. If it doesn't, the block fails before its script starts, with `Working directory does not exist: <path>`.

### One session per runbook

The app has one window and one session. Every script in a runbook shares it. Runbooks saves the session, and opening the runbook again resumes it, even after you restart the app. See [Sessions](/commands/sessions/). To reset the environment, use the session controls in the UI. Resetting removes the variables that scripts set, and signs every auth block out. To start the runbook over, choose **File > Reset Session**. To go back to an earlier session, choose **File > Switch Session…**.

### Starting environment

The session starts from the environment the Runbooks app was started with.

If you start Runbooks from a terminal or an SSH session, it uses that terminal's environment as it is. A variable you set on the command line that starts Runbooks, such as `AWS_PROFILE=prod`, is the value your scripts see.

If you start Runbooks from Finder, the Dock or a desktop launcher on macOS or Linux, it first runs your login shell once as `$SHELL -ilc` and copies the environment that shell ends up with. Because the shell is both a login and an interactive shell, it reads your profile and rc files, so your `PATH` and the variables they export are available to scripts.

On Windows, Runbooks uses the environment it was started with.

A [resumed session](/commands/sessions/#resuming-a-session) starts from that same environment, and then gets back the variables its scripts had set when it was last open, and its auth blocks' sign-ins.

When a [\<Prerequisites\>](/authoring/blocks/prerequisites/) block can't find a tool, Runbooks runs your login shell again, on macOS and Linux, to read `PATH`. It adds the directories that `PATH` has and the session's doesn't to the end of the session's `PATH`, and of the environment later sessions start from. See [Tools installed after Runbooks started](/authoring/blocks/prerequisites/#tools-installed-after-runbooks-started).

### How a script's variables are applied

When a script exits with code 0 or 2, Runbooks sets the variables it wrote to `$RUNBOOK_ENV`. Every other variable in the session is left as it is. If another script changed the session while this one was running, those changes are kept. If both set the same variable, the script that finished last wins.

If you open a different runbook while a script is running, the finished script's variables are discarded. The same applies to a sign-in or a `<GitClone>` still in progress when you switch: its credentials and checkout are not added to the new runbook's session. Sign in or clone again from the new runbook.

[Switching sessions](/commands/sessions/#switching-sessions) with **File > Switch Session…** stops a running script instead. Runbooks asks first.

### Running scripts at the same time

You can click Run on a block while another block's script is still going, and both keep running. Runbooks holds a block back when it can tell the block has to wait: the block uses the outputs of a block that is running, names a block in `dependsOn` that hasn't succeeded, or would overlap with an `exclusive` block. See [Run order](/authoring/blocks/command/#run-order).

Runbooks can't tell that one script reads a variable another script sets. A script gets the session as it stood when you clicked Run, and Runbooks sets its variables when it finishes, so two scripts running together don't see each other's variables. If a script needs a variable an earlier block sets, name the earlier block in its `dependsOn`. When overlapping scripts set the same variable, the last one to finish wins.

Runbooks discards the variables of a script you stop.

## Built-in environment variables

Runbooks sets the following environment variables for every script:

| Variable | Description |
|----------|-------------|
| `GENERATED_FILES` | Path to a temporary directory where scripts can write files to be captured. Files written here appear in the **Generated files** tab when the script exits with code 0 or 2. |
| `RUNBOOK_ENV` | Path to a file where scripts can write `NAME=value` lines to set variables in the session for later blocks (see [Setting variables for later blocks](#setting-variables-for-later-blocks)). |
| `REPO_FILES` | Path to the active git worktree: the one selected in the workspace's repository dropdown, which is the first one added, whether by a clone or a [local checkout](/authoring/blocks/gitclone/#using-a-local-checkout), until you select another. Unset until a `<GitClone>` block has added a repository. |
| `RUNBOOK_OUTPUT` | Path to a file where scripts can write `key=value` pairs to produce [block outputs](/authoring/blocks/command/#block-outputs) for later blocks. Write `sensitive:key=value` to mask a credential in the UI (see [Sensitive outputs](/authoring/inputs-and-outputs/#sensitive-outputs)). |

Each script also gets one log file per level: `RUNBOOK_INFO_LOG`, `RUNBOOK_WARN_LOG`, `RUNBOOK_ERROR_LOG` and `RUNBOOK_DEBUG_LOG`. Each line a command or script appends to one shows up in the block's logs at the file's level, as the script writes it. The files are deleted when the run ends. See [Logging](/authoring/blocks/command/#logging).

### Capturing output files

Write files to `$GENERATED_FILES` to save them to the generated files directory:

```bash
#!/usr/bin/env bash
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
#!/usr/bin/env bash
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
| Environment variables | Yes | The session's environment, including variables earlier scripts set, plus the credentials of the auth blocks the block's [`envFrom`](/authoring/blocks/command/#using-credentials-from-an-auth-block) names |
| Binaries in `$PATH` | Yes | `git`, `aws`, `tofu` and so on |
| Shell aliases | No | `ll`, `la`, custom aliases |
| Shell functions | No | `nvm`, `rvm`, `assume` and so on |
| RC files | No | Scripts do not source `.bashrc` or `.zshrc`. On a desktop launch Runbooks reads them once at startup for exported variables only (see [Starting environment](#starting-environment)). |
| A terminal (TTY) | No | Tools may turn off colors and progress bars, and a `sudo` password prompt fails |
| Standard input | No | Input is empty, so `read` and confirmation prompts get no answer. Use non-interactive flags such as `-auto-approve` or `-y` |

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
#!/usr/bin/env bash
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
#!/usr/bin/env bash
source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null

nvm --version
```

## How a script runs

Runbooks picks the program that runs a block's script in this order:

1. The script's shebang line.
2. The block's `interpreter` prop.
3. The script file's extension.
4. `bash`, for an inline `command` or a file without an extension.

Runbooks writes each script to a file under the session directory's `.runbooks/scripts/` folder and removes it when the run ends.

### Scripts with a shebang

On macOS and Linux, Runbooks runs a script that starts with a shebang as a program, so the operating system starts the interpreter the shebang names, as a terminal would:

- an absolute path such as `#!/opt/homebrew/bin/bash` runs that file, not the first `bash` on `PATH`
- `#!/usr/bin/env bash` runs the first `bash` on the session's `PATH`
- `#!/bin/sh` runs the system's `sh`, which is `dash` on Debian and Ubuntu, so the script can't use bash features
- `#!/usr/bin/env -S` works where the system's `env` supports it
- arguments after the interpreter follow the system's rules. Linux passes everything after the interpreter as one argument, so `#!/usr/bin/env bash -e` fails there. Put `set -euo pipefail` in the script instead.

Windows can't run a file by its shebang. There, Runbooks starts the program the shebang names, found on `PATH`, with the shebang's arguments. `#!/usr/bin/env bash` and `#!/bin/bash` both start the first `bash` on `PATH`, such as Git Bash.

### The interpreter prop

A Command, Check or Finish block can name the program for a script that has no shebang with the `interpreter` prop. It reads like a shebang line without the `#!`: a program on the session's `PATH`, then any arguments.

```mdx
<Command id="hello" interpreter="python3" command='print("hello")' />

<Command id="check-types" interpreter="deno run" path="scripts/check.ts" />
```

In a script file, prefer a shebang. It stays with the file when someone runs the script in a terminal, and the prop doesn't.

A block can't have both. A block whose script starts with a shebang and that sets `interpreter` shows `The script starts with a shebang line, and the block sets the interpreter prop. Remove one of them.` and can't run. If a script file gains a shebang after the runbook loads, the shebang wins.

### Scripts without a shebang or interpreter

An inline `command`, and a script file without an extension, run with `bash`. A script file runs with the program for its extension:

| Extension | Program |
|-----------|---------|
| `.sh`, `.bash` | `bash` |
| `.zsh` | `zsh` |
| `.py` | `python3` |
| `.js`, `.mjs`, `.cjs` | `node` |
| `.rb` | `ruby` |
| `.pl` | `perl` |
| `.ps1` | `pwsh` |

A script file with any other extension, no shebang and no `interpreter` prop fails before it runs, with a message such as `Runbooks can't tell which program runs check.ts. Add a shebang line, such as #!/usr/bin/env python3, to the top of the script, or set the block's interpreter prop.`

### Recommended first lines

Start each script with a shebang, so it runs the same in Runbooks, in a terminal and in CI:

```bash
#!/usr/bin/env bash
set -euo pipefail
# Your script here...
```

## Demo runbooks

The Runbooks repository has demo runbooks for these features.

[`runbook-execution-model`](https://github.com/gruntwork-io/runbooks/tree/main/testdata/feature-demos/runbook-execution-model) covers the session environment:

- Setting variables for later blocks with `$RUNBOOK_ENV`
- Multiline values (RSA keys, JSON)
- Running a block in another directory with `workingDir`
- A Python script reading and setting session variables

[`capture-files-from-scripts`](https://github.com/gruntwork-io/runbooks/tree/main/testdata/feature-demos/capture-files-from-scripts) covers file capture:

- Using `$GENERATED_FILES` to capture generated files
- Creating OpenTofu configs from environment variables set in earlier blocks

[`file-workspace`](https://github.com/gruntwork-io/runbooks/tree/main/testdata/feature-demos/file-workspace) covers the file workspace:

- Cloning a repository with `<GitClone>` and browsing its files
- Using `$REPO_FILES` to modify files in a cloned repo
- Writing templates directly into a worktree with `target="worktree"`
- Viewing changes in the **Changed files** diff view
