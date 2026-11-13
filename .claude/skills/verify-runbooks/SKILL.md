---
name: verify-runbooks
description: Drive the Runbooks desktop app (Electron) the way a user does, one action at a time, and capture evidence that a change works. Use to prove a block's UI, a runbook's flow, or a fix in the real app rather than only in tests, especially the TfModule and TerragruntApply blocks and simulation mode.
---

# Verify Runbooks

Runbooks is an Electron app: a runbook (MDX) renders as blocks the user fills in and runs. You drive it with `control-runbooks`, which launches the built app with a Chrome DevTools Protocol port and then does one user action or one read per command, printing one JSON object. The app keeps running between commands.

```sh
C=.claude/skills/verify-runbooks/bin/control-runbooks   # run from the repository root
$C --help             # every command
$C click --help       # one command's flags and an example
```

Getting to a feature is fixed setup (`$C setup ...`). Proving it is you: read the state, act, wait for what a user would see, read again, and decide the next step from what you saw. Don't replay a list blind. Scripted checks of exact output belong in the automated tests each feature file names.

## Launch

```sh
$C up testdata/feature-demos/tf-module --simulate
```

`up` rebuilds `dist/` first when any file under `electron/`, `src/` or `web/src/` is newer (about a minute; `--no-build` skips it), then starts Electron on the runbook with its own user-data folder and HOME, and without the shell's cloud and Git host credentials (`AWS_*`, `GOOGLE_*`, `CLOUDSDK_*`, `GITHUB_*`, `GH_*`, `GITLAB_*` and the like), so it never touches your real sessions or sign-ins. On Linux without a display it runs under `xvfb-run`. It returns once the window has rendered the runbook's header, which means usable, not just that a process answers.

- `--simulate` opens the runbook in simulation mode: lookups, checks, and `<TerragruntApply>` plans and applies answer from the runbook's `simulation.yml`. GitHub and GitLab sign-ins and clones are real, since they only read. Anything else that would reach a real system, such as an AWS or Google sign-in, a script, a push or a pull request, is refused with an error. Use `--simulate` for any runbook that has a `simulation.yml`.
- `--real-home` keeps your HOME and your shell's credentials, so saved GitHub and cloud sign-ins apply. Only for journeys that need a real account, and never with destructive clicks you haven't dry-run. The app's debugging port, which this tool drives the window through, takes no password, so while it runs any program on this computer can read what the window holds, sign-ins included.
- `--instance <name>` runs a second app beside the first; every later command takes the same flag. `up` refuses to start an instance that's already running.

## Doctor

```sh
$C doctor
```

Read-only. Checks the build is current, the process is alive, the console recorder runs, the window is reachable, and simulation is on when `up` asked for it. `state.trusted` says whether the runbook still asks to be trusted (not a fault; `setup trust` clears it). Run it first whenever anything looks off.

## Setup

| Sequence | End state |
| --- | --- |
| `$C setup trust` | No trust prompt: blocks can run. |
| `$C setup scenario <name-or-label>` | The simulation bar's Scenario picker shows that scenario. For the TfModule demo: `happy-path`, `no-directory-access`, `api-off`, `apply-fails`, `group-exists`. |
| `$C setup group-form [block-id]` | The TfModule demo's Google Group block (`group`) has Organization example.com, Group email platform, Name Platform team, and Sam Rivera as an owner, with nothing needing a fix. Trusts the runbook first. |
| `$C setup group-code [block-id]` | `group-form`, then Generate: the block lists its code, and the `apply-group` block shows the unit's path and Plan. |

A sequence stops at the first step whose end state doesn't appear and reports that step and a screenshot. Setup is for preconditions only: when the behavior under test is filling the form, fill it yourself.

## Drive

Read before you act. `snapshot` prints the accessibility tree (roles, names, values, states) as lines; scope it to a block so it stays short:

```sh
$C snapshot --within group
```

Name elements the way a user sees them, by role and accessible name, label, or text. Scope with `--within <block-id>` (a block's `id` prop is its `data-testid`):

```sh
$C click tab:Code --within group                      # role:name shorthand
$C click "button:Merge Pull Request" --within group
$C fill platform --label "Group email" --within group
$C type ana --label Members --within group             # key by key, so suggestions open
$C click option:"Ana Lima" --within group
$C select "Squash and merge" --label "Merge method" --within group
$C press Enter
$C wait --text "Applied." --within group --timeout 15000
$C wait button:Stop --within group --gone
```

A target that matches nothing fails with the closest names on screen; one that matches several lists them and asks for `--exact`, `--within`, or `--nth`. Hidden tab panels don't match, so open the tab first. Anything that runs (Plan, Apply, Create Pull Request, Merge) takes time: `wait` for the next thing the user would see before acting again.

`--dry-run` on any acting command resolves the target and reports what it would do without doing it. Use it before a click that would change something real (a real pull request or apply without `--simulate`).

Escape hatches, for what the commands don't cover: `$C eval '<expression>'` evaluates in the renderer, and `$C cdp <Domain.method> '<json>'` sends a raw DevTools Protocol command. Don't use them to change app state a user couldn't, which would void the proof.

The feature map in [features/README.md](features/README.md) lists what to drive and what proves each feature works.

## Evidence

Every acting command and every setup saves a numbered screenshot of the window and appends a line to `journal.jsonl` in the instance's evidence folder, `.verify-runbooks/evidence/<started-at>-<instance>/` (its path is in `up`'s output as `evidenceDir`). `$C screenshot <label> [--within block]` adds one on purpose. `$C logs` reads the renderer console and `$C logs --source main` the main process output; `down` copies both into the evidence folder.

Proof standards:

- Use the real user path: clicks, typing, picks. Never `eval` a setter or call IPC to skip a step.
- Capture the action and the resulting state, not just the final screen. A journey's screenshots should read as a story.
- Check side effects alongside the screen. In simulation, nothing is applied: confirm the plan's resources follow the form's inputs. Without simulation, check the files in the cloned repository, the branch, and the pull request.
- Judge each step by what the user should be able to tell from the screen alone: is anything missing, repeated, contradictory, or in the app's internal terms, and is it clear what happens next? Confusing output with the right end state is a finding, not a pass. Report it with the screenshot.
- Exact text that users or scripts rely on belongs in the automated tests the feature file names, not in a pinned string here.

## Cleanup

```sh
$C down              # or: $C down --dry-run to see what it would stop and remove
```

Stops exactly the process group `up` started (and the console recorder), never by process name, and removes the instance's scratch state (`.verify-runbooks/state/<instance>/`). The evidence folder stays. Run `down` after every failed attempt too, so no Electron or Xvfb is left behind.

## Helpers

- `bin/control-runbooks` is the entry point; it runs `scripts/control-runbooks/cli.ts` with bun from anywhere in the repository.
- The CLI's source and its tests live in `scripts/control-runbooks/` (`bun test scripts/control-runbooks`). Add a setup sequence in `setups.ts` when a journey needs a precondition that takes more than a step or two.
- Proven in a Linux container under Xvfb. On macOS and Windows the window opens on screen and `up` doesn't wrap it, which no run has covered yet.
