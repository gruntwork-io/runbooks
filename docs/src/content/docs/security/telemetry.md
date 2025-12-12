---
title: Telemetry
description: Understanding what anonymous usage data Runbooks collects and how to disable it
---

## Overview

Runbooks collects anonymous telemetry data to help us understand how the tool is used and prioritize improvements. We've designed our telemetry with privacy in mind: it's minimal, anonymous, and easy to disable.

**Telemetry is enabled by default**, but you can opt out at any time using the methods described below.

## What We Collect

We collect the following anonymous data:

| Category | Data Points | Purpose |
|----------|-------------|---------|
| Commands | `open`, `watch`, `serve` invocations | Understand which CLI commands are most used |
| Platform | Operating system, architecture | Ensure compatibility across platforms |
| Version | Runbooks version | Track adoption of new versions |
| Blocks | Block types in runbooks (Command, Check, Template, Inputs) | Prioritize feature development |
| Errors | Error types (not messages or content) | Improve reliability |

## What We Do NOT Collect

We take your privacy seriously. We **never** collect:

- **Runbook content** - Your runbook text, scripts, or commands
- **File paths** - The location of your runbooks on disk
- **Variable values** - Any input values you enter
- **Script output** - The results of running commands
- **Personal identifiable information** - No names, emails, or usernames
- **IP addresses** - We configure our analytics provider to discard IPs

## How We Anonymize Data

We generate an anonymous identifier for each user based on a SHA-256 hash of your machine's hostname and username. This means:

- **Stable**: The same ID is used across sessions on your machine
- **Anonymous**: The hash cannot be reversed to identify you
- **Unique**: Different machines/users have different IDs

We cannot determine who you are from this identifier.

## How to Disable Telemetry

You can disable telemetry using either of these methods:

### Environment Variable (Recommended)

Set the `RUNBOOKS_TELEMETRY_DISABLE` environment variable to `1`:

```bash
# For a single command
RUNBOOKS_TELEMETRY_DISABLE=1 runbooks open my-runbook

# Or add to your shell profile (~/.bashrc, ~/.zshrc, etc.) for permanent opt-out
export RUNBOOKS_TELEMETRY_DISABLE=1
```

### CLI Flag

Use the `--no-telemetry` flag with any command:

```bash
runbooks --no-telemetry open my-runbook
runbooks --no-telemetry watch my-runbook
```

## Telemetry Notice

When telemetry is enabled, Runbooks displays a notice at startup:

```
📊 Telemetry is enabled. Set RUNBOOKS_TELEMETRY_DISABLE=1 to opt out.
   Learn more: https://runbooks.gruntwork.io/security/telemetry/
```

This notice appears every time you run a command to ensure transparency. When you disable telemetry, the notice will no longer appear.

## Data Storage and Retention

Telemetry data is sent to [Mixpanel](https://mixpanel.com/), a third-party analytics service. Data is:

- Transmitted securely over HTTPS
- Stored according to Mixpanel's data retention policies
- Accessible only to the Gruntwork team

## Open Source Transparency

Runbooks is open source, and our telemetry implementation is fully visible in the codebase:

- **Backend**: [`api/telemetry/telemetry.go`](https://github.com/gruntwork-io/runbooks/blob/main/api/telemetry/telemetry.go)
- **Frontend**: [`web/src/contexts/TelemetryContext.tsx`](https://github.com/gruntwork-io/runbooks/blob/main/web/src/contexts/TelemetryContext.tsx)

You can review exactly what data is collected and how it's sent.

## Why We Collect Telemetry

As an open source project, telemetry helps us:

1. **Prioritize features** - Understand which capabilities matter most to users
2. **Fix bugs faster** - Identify and address the most impactful issues
3. **Support platforms** - Know which operating systems and architectures to prioritize
4. **Measure adoption** - Track how new versions are being adopted

We're committed to building Runbooks in the open and respecting user privacy. If you have questions or concerns about our telemetry practices, please [open an issue](https://github.com/gruntwork-io/runbooks/issues) on GitHub.

