---
title: Telemetry
description: What usage data Runbooks sends, when it sends it, and how to turn it off
---

Runbooks can send usage events to [Mixpanel](https://mixpanel.com/), a third-party analytics service. Telemetry is on unless you [opt out](#how-to-disable-telemetry).

## When telemetry is sent

Runbooks sends events only when it has a Mixpanel project token in two places: `VITE_MIXPANEL_TOKEN` when the app is built, and `MIXPANEL_TOKEN` in the app's environment when it runs. If either is missing, nothing is sent. The release workflow in this repository sets neither, and a build from source sets neither unless you do.

## What is sent

The renderer sends two events.

| Event | When | Extra properties |
|-------|------|------------------|
| `app_loaded` | The app window loads | None |
| `runbook_loaded` | Half a second after the blocks of a runbook finish rendering | `block_counts`, the number of blocks of each type in the runbook (such as `Command: 3`), and `total_blocks` |

Block counts cover Command, Check, Inputs, Template, TemplateInline, DirPicker, GitClone, the auth blocks and the pull request blocks. Admonition and Iframe blocks are not counted.

Every event also has these properties:

| Property | Value |
|----------|-------|
| `distinct_id`, `$user_id` | The [install identifier](#the-install-identifier) |
| `$device_id` | A random ID the Mixpanel library generates and keeps in the app's local storage |
| `version` | The Runbooks version |
| `platform` | Always `electron` |
| `$os`, `$browser`, `$browser_version` | Read from the app's user agent string by the Mixpanel library |
| `$screen_width`, `$screen_height` | Your screen size in pixels |
| `$current_url` | The `file://` URL of the app's own page |
| `$initial_referrer`, `$initial_referring_domain` | Always `$direct`, because the app has no referrer |
| `mp_lib`, `$lib_version`, `$insert_id`, `time` | The Mixpanel library name and version, a random event ID and a timestamp |

`$current_url` is the path of the installed app, so it includes your OS username if you installed Runbooks under your home directory. It also includes the `#anchor` of the last in-page link you clicked in a runbook.

## What is not sent

- Runbook text, scripts and commands, apart from the anchor described above
- The location of your runbooks on disk
- Values you type into inputs
- Script output
- Your IP address. The Mixpanel client is configured with `ip: false`, which tells Mixpanel not to store the address the request came from.

## The install identifier

Events are tied together by a SHA-256 hash of `hostname:username`. Mixpanel receives only the hash. The hash is the same every time you run Runbooks as that user on that machine.

The hash is a pseudonym. Anyone who knows or guesses your hostname and username can compute it and match it to your events.

## How to disable telemetry

Pass `--no-telemetry` when you start Runbooks:

```bash
runbooks open --no-telemetry path/to/runbook
```

Or set `RUNBOOKS_TELEMETRY_DISABLE` to `1`, `true` or `yes`:

```bash
# Add to your shell profile (~/.bashrc, ~/.zshrc) to opt out permanently
export RUNBOOKS_TELEMETRY_DISABLE=1
```

## Where the data goes

Events go to Mixpanel over HTTPS and are kept according to Mixpanel's data retention policies. The Gruntwork team has access to them.

## Source

The telemetry code is in two files:

- Main process: [`src/telemetry.ts`](https://github.com/gruntwork-io/runbooks/blob/main/src/telemetry.ts)
- Renderer: [`web/src/contexts/IpcTelemetryContext.tsx`](https://github.com/gruntwork-io/runbooks/blob/main/web/src/contexts/IpcTelemetryContext.tsx)

Gruntwork uses the data to see which block types runbooks use and which Runbooks versions are in use. If you have questions about telemetry, [open an issue](https://github.com/gruntwork-io/runbooks/issues).
