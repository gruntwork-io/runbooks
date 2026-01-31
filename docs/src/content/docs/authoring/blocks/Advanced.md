---
title: Advanced
sidebar:
   order: 6
---

This page covers advanced configuration options for Command and Check blocks.

## Pseudo-Terminal (PTY) Support

By default, Runbooks executes scripts using a pseudo-terminal (PTY) on Unix-like systems. This enables full terminal emulation, which means CLI tools behave as if running in a real terminal.

### Why PTY Matters

Many CLI tools (git, npm, docker, terraform, etc.) detect when they're not running in a terminal and change their behavior:

- Progress bars are suppressed
- Colors are disabled
- Some output is hidden entirely

With PTY support enabled (the default), you get the full interactive experience:

```
$ git clone https://github.com/acme/my-repo
Cloning into 'my-repo'...
remote: Enumerating objects: 1234, done.
remote: Counting objects: 100% (1234/1234), done.
Receiving objects:  45% (556/1234)...
```

Without PTY (pipes mode), the same command might only show:

```
$ git clone https://github.com/acme/my-repo
Cloning into 'my-repo'...
```

### Controlling PTY Mode

Both `<Command>` and `<Check>` blocks support the `usePty` prop:

```mdx
{/* Default: uses PTY for full terminal emulation */}
<Command id="deploy" path="scripts/deploy.sh" />

{/* Explicit PTY mode */}
<Command id="deploy" path="scripts/deploy.sh" usePty={true} />

{/* Pipes mode: disables PTY */}
<Command id="deploy" path="scripts/deploy.sh" usePty={false} />
```

### When to Disable PTY

While PTY mode is generally preferred, there are cases where you might want to disable it:

- Script output is garbled or corrupted
- Script hangs or behaves unexpectedly
- Script relies on detecting non-TTY mode
- You need raw, unprocessed output

On the other hand, if progress bars and colors work correctly, then PTY mode is likely working well.

### Platform Support

| Platform | Default Execution Method |
|----------|-------------------------|
| macOS    | PTY (full support) |
| Linux    | PTY (full support) |
| Windows  | Pipes (PTY not available) |

On Windows, scripts always run in pipes mode regardless of the `usePty` setting.