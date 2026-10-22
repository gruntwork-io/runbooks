#!/bin/sh
## Template for the `runbooks` command that Runbooks installs as
## /usr/local/bin/runbooks on macOS and Linux. renderUnixLauncher in
## electron/main/cli-install.ts fills in each {{name}} and drops every line
## that starts with ##, so these notes never reach the installed file.
##
## Like `code .`, the launcher starts the app in the background with its
## output discarded and returns at once. The app still gets the caller's
## arguments, working directory and environment, so relative paths and the
## handoff to an already running instance work as before.
##
## Not `open -a`: for an app that is already running, LaunchServices only
## activates it and drops the arguments, and it starts the app in `/` with
## its own environment rather than the terminal's.
##
## {{marker}} is LAUNCHER_MARKER: install and uninstall only replace or remove
## a file that contains it. Every release has written it on line 2.
# {{marker}}
## {{app}} is the absolute path of the app's executable, quoted for sh.
app={{app}}
## Stderr is discarded below, so a moved or deleted app would otherwise fail
## silently. 127 is what sh itself exits with then.
if [ ! -x "$app" ]; then
  printf "runbooks: Runbooks was not found at %s. If you moved or reinstalled it, open Runbooks and install the 'runbooks' command again.\n" "$app" >&2
  exit 127
fi
## {{verboseFlag}} anywhere in the arguments runs the app in the foreground
## instead, attached to the terminal (see VERBOSE_FLAG in cli-install.ts).
for arg in "$@"; do
  if [ "$arg" = {{verboseFlag}} ]; then exec "$app" "$@"; fi
done
## A plain `&` is not enough to keep the terminal from reaching the app. From
## a shell script, the app would stay in the launcher's process group. When
## the launcher is a terminal's own command (a VS Code task, `xterm -e`), the
## kernel sends SIGHUP to that group as the launcher exits, killing the app
## before it opens a window. When a wrapper script runs `runbooks .`, Ctrl+C
## reaches it, because Electron replaces the SIGINT that sh ignores for
## background commands with its own handler. So the app is moved out of the
## launcher's process group below.
##
## SIGHUP is ignored for the moment between starting setsid and the app
## leaving the session. Runbook scripts do not inherit ignored signals,
## because child_process resets every signal to its default in the processes
## it spawns.
trap '' HUP
## setsid(1), which Linux has, gives the app a session of its own.
if command -v setsid >/dev/null 2>&1; then
  setsid "$app" "$@" </dev/null >/dev/null 2>&1 &
else
  ## macOS has no setsid(1), but its /bin/sh is bash, whose job control
  ## (`set -m`) gives the app a process group of its own, outside the
  ## terminal's foreground group. Not under dash, which would stop
  ## `runbooks . &` for terminal input.
  if [ -n "${BASH_VERSION-}" ]; then set -m; fi
  "$app" "$@" </dev/null >/dev/null 2>&1 &
fi
