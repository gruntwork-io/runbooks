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

So opening a runbook, from your machine or from a remote URL, runs no code of its own. The scripts in `<Command>` and `<Check>` blocks run when you click Run.

## Executable registry

When a runbook opens, the main process reads `runbook.mdx`, finds every `<Check>` and `<Command>`, and stores each script (the `command` prop, or the file named by `path`) in an in-memory registry under a unique executable ID, along with the block ID and its template variables.

When you click Run, the renderer sends an execution request with the executable ID, the template variable values, environment variable overrides from the auth blocks the block references, and a timeout. It never sends script content. The main process looks the ID up in the registry, renders the stored script with the given variables, and runs it. A request for an ID that is not in the registry is refused, so a manipulated IPC message cannot pick a script the runbook did not contain. Template values are inserted into the script verbatim and environment overrides are applied as sent, so a manipulated request can change what the stored script does, though not which script runs.

## Electron settings

The renderer runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`. It has no access to Node.js APIs or the file system and talks to the main process only through the API that the preload script exposes with `contextBridge`. Script execution, file access and environment management all happen in the main process, which is a separate OS process from the renderer.

`webviewTag` is enabled so the [Iframe block](/authoring/blocks/iframe/) can embed pages in `<webview>` guests. Before a guest attaches, the main process removes its preload script and denies dialogs, downloads, `window.open` and permission requests from the embedded page.

## When the registry is built

Every script Runbooks runs comes from the registry. The ways of opening a runbook differ in when the registry is rebuilt from the files on disk.

### Opening a runbook

```bash
runbooks open path/to/runbook.mdx
```

The registry is built once, when the runbook opens. Changes you make to the runbook or its scripts afterwards do not run until you close and reopen the runbook. This is the mode for consumers who want to run exactly what the author wrote.

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

## How scripts run

1. The main process checks that the executable ID is in the registry.
2. It renders template variables such as `{{ .VarName }}` into the script.
3. It writes the script to a temporary file.
4. It reads the shebang line to pick the interpreter, defaulting to `bash`.
5. It runs the interpreter on the file in a non-interactive shell.
6. It streams stdout and stderr to the renderer over IPC.
7. It deletes the temporary file.

Scripts run with your user's permissions and full environment. Only run runbooks you trust.

For interpreter detection, shell limitations and how environment changes persist between scripts, see [Shell execution context](/security/shell-execution-context/).
