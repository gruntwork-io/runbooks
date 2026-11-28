---
title: Execution security model
description: How Runbooks decides which scripts may run, and how it runs them
---

Runbooks runs the commands and shell scripts in a runbook directly on your computer, with the environment variables the app was started with. This page describes the checks Runbooks applies before a script runs.

## Trust warning

Every runbook opens with a banner asking you to confirm that you trust it. The banner has an "I trust this Runbook" checkbox and an option to hide it for that runbook path.

## Opening a runbook never runs its code

A `runbook.mdx` file is compiled and rendered inside the Runbooks app, so Runbooks only accepts MDX that is purely declarative. If a runbook contains any of the following, Runbooks shows an error instead of rendering it:

- `import` or `export` statements
- JavaScript expressions, such as `{new Date().toString()}` or `command={buildCommand()}`
- Spread props, such as `<Command {...props} />`
- `<script>` elements, and elements that embed another document: `<iframe>`, `<frame>`, `<frameset>`, `<object>`, `<embed>` and `<webview>`
- Props that inject raw HTML: `dangerouslySetInnerHTML` and `srcDoc`
- Custom elements (element names with a `-`, such as `<my-widget>`), dotted element names (such as `<Admonition.Title>`) and namespaced element names (such as `<svg:script>`)
- `__proto__` as a prop name or object key
- `javascript:` URLs in any prop, such as `<a href="javascript:...">`

You can still use `{...}` for literal values: strings, numbers (including a leading `-` or `+`), booleans, `null`, regex literals, template strings without `${...}` substitutions, and arrays or objects made only of those. For example, `detectCredentials={['env']}` and `detectCredentials={[{ env: { prefix: 'PROD_' } }, 'env']}` are allowed, and so are `{/* comments */}`.

So opening a runbook, from your machine or from a remote URL, runs no code of its own. The scripts in `<Command>` and `<Check>` blocks run when you click Run, and a `<Finish>` block's final check when you click Finish. A `<Prerequisites>` block runs when you click Check: it runs the tools it lists that it reads a version of, and your login shell if one of the tools is missing.

## Executable registry

When a runbook opens, the main process reads `runbook.mdx`, finds every `<Check>` and `<Command>`, and every `<Finish>` with a final check, and stores each script (the `command` prop, or the file named by `path`) in an in-memory registry under a unique executable ID, along with the block ID and its `env`, `envFrom` and `workingDir` props. It stores the tool list of each `<Prerequisites>` block the same way. A check runs only the tools in its list, with the version arguments the list gives them, and takes no template values or credentials.

The main process reads the file as the renderer does. A block in a code block, in inline code or in a `{/* comment */}` isn't stored, and a runbook that isn't valid MDX, or that contains anything listed in [the section above](#opening-a-runbook-never-runs-its-code), stores nothing.

When you click Run, the renderer sends an execution request with the executable ID, the template variable values and a timeout. It never sends script content or credentials. The main process looks the ID up in the registry, renders the block's `env` and `workingDir` with the given variables, adds the credentials of the auth blocks the registry's copy of `envFrom` names, and runs the stored script. A request for an ID that is not in the registry is refused, so a manipulated IPC message cannot pick a script the runbook did not contain. The registry holds the scripts the runbook had when it was loaded, and any script file you [reloaded yourself](#reloading-a-changed-script-file) after reviewing a change. Template values reach the script through its `env` and `workingDir`, so a manipulated request can change the values the stored script gets, though not which script runs or which auth blocks' credentials it gets.

## Electron settings

The renderer runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`. It has no access to Node.js APIs or the file system and talks to the main process only through the API that the preload script exposes with `contextBridge`. Script execution, file access and environment management all happen in the main process, which is a separate OS process from the renderer.

`webviewTag` is enabled so the [Iframe block](/authoring/blocks/iframe/) can embed pages in `<webview>` guests. Before a guest attaches, the main process removes its preload script and denies dialogs, downloads, `window.open` and permission requests from the embedded page.

## Git commands

Runbooks runs `git` itself to clone repositories and to look at a local checkout, including one a `<GitClone>` block names before you have chosen it. A repository's own config can name commands for git to run, and that config arrives with the directory, so Runbooks overrides two settings for every `git` it runs:

- `core.fsmonitor` is off. It can name a command that `git status` and `git ls-files` run.
- `safe.bareRepository` is `explicit`. A directory that only holds a repository's files (`HEAD`, `objects/`, `refs/`), which a clone can contain as ordinary committed files, is not opened as a repository. A `.git` directory, a linked worktree and a submodule work as usual.

Git ignores settings it doesn't know without saying so. Runbooks checks the Git version before it looks at a local checkout:

- Git older than 2.31 can't take either setting, so Runbooks refuses with a message.
- Git 2.31 to 2.37 (for example Ubuntu 22.04's 2.34) doesn't know `safe.bareRepository`, so Runbooks makes the same check itself before running Git there. It walks up from the chosen directory as Git would, and refuses if it reaches a directory with `HEAD`, `objects/` and `refs/` before it reaches a `.git`.

This covers the `git` commands Runbooks runs. A script that runs `git` gets your own git configuration.

## When the registry is built

Every script Runbooks runs comes from the registry. The ways of opening a runbook differ in when the registry is rebuilt from the files on disk.

### Opening a runbook

```bash
runbooks open path/to/runbook.mdx
```

The registry is built once, when the runbook opens. Changes you make to the runbook or its scripts afterwards do not run until you close and reopen the runbook, or until you [reload a changed script file](#reloading-a-changed-script-file) from its block. This is the mode for consumers who want to run exactly what the author wrote.

### Watch mode

```bash
runbooks open --watch path/to/runbook.mdx
```

Runbooks watches the runbook file and reloads the UI when it changes. Each reload rebuilds the registry from the runbook and the scripts it references as they are on disk at that moment. Execution still goes through the registry, but whatever is on disk at reload becomes approved, so anything that can write to the runbook's files while you work can change what runs. This is the mode for authors editing their own files.

### Freezing the registry

```bash
runbooks open --watch --disable-live-file-reload path/to/runbook.mdx
```

`--disable-live-file-reload` keeps the registry built when the runbook was opened in this app session. Watch mode still reloads what the app shows, but Runbooks keeps executing the scripts that were present at open, and blocks whose script has changed show a "Script changed" warning. Opening a different runbook builds its registry as usual, and coming back to this one rebuilds its registry.

Freezing the registry does not stop you from [reloading a changed script file](#reloading-a-changed-script-file) from its block.

### Reloading a changed script file

Runbooks watches the script files that `<Check>`, `<Command>` and `<Finish>` blocks reference with `path`, in every mode. When one changes on disk after the registry was built, nothing about what runs changes. Its block shows a "Script changed" notice with a diff between the version in the registry and the version on disk, and a **Reload script** button.

**How it works:**
1. Until you click **Reload script**, Run executes the version in the registry, which is also the version under "View Source Code"
2. The click sends the main process the block's ID and the hash of the version you reviewed, never a path or script content
3. The main process reads the file again from the path the registry entry was built from, and replaces that one entry only if the content has the hash you reviewed
4. If the file changed again in between, the reload is refused and the notice shows the latest diff

**Security:**
- A changed script is never executed without a click on a notice that shows what changed
- The reload approves the content you saw. A write that lands between the diff and the click is rejected
- Only script files are covered. A changed inline `command` is part of `runbook.mdx`, so it needs the runbook to be reloaded

## How scripts run

1. The main process checks that the executable ID is in the registry.
2. It renders the block's [`env`](/authoring/blocks/command/#passing-values-as-environment-variables) and `workingDir` values, from the registry's copy of the runbook, with the block's inputs and outputs. The script itself runs as the registry holds it.
3. It writes the script to a file in the session directory's `.runbooks/scripts/` folder, readable and runnable only by your user.
4. On macOS and Linux it runs a script with a shebang as a program, so the operating system starts the interpreter the shebang names. It runs a script without one with `bash`, or with the program for its file's extension. On Windows it starts the program the shebang names. See [How a script runs](/security/shell-execution-context/#how-a-script-runs).
5. The script runs in a non-interactive shell, in the block's `workingDir` or the session's directory, with the `env` values set as environment variables for this run.
6. It streams stdout and stderr to the renderer over IPC.
7. It deletes the script file.

Scripts run with your user's permissions and full environment. Only run runbooks you trust.

A value in `env` reaches the script as data, and the shell never runs it, even when it holds text from outside the runbook, such as a PR title or an API response. Runbooks runs the script itself as written. See [Templates in the script](/authoring/blocks/command/#templates-in-the-script).

For how a script's interpreter is picked, shell limitations and how scripts set variables for later blocks, see [Shell execution context](/security/shell-execution-context/).
