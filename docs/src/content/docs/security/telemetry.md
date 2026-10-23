---
title: Telemetry
description: Runbooks sends no usage data. What its update check sends to GitHub.
---

Runbooks sends no usage data. It has no analytics and no crash reporting.

Earlier versions contained code for sending usage events to Mixpanel, but no release was configured to send them. That code has been removed.

## Update checks

The installed app checks GitHub for a new release each time it starts, about ten seconds after launch. It uses [electron-updater](https://github.com/electron-userland/electron-builder/tree/master/packages/electron-updater) with the [releases of gruntwork-io/runbooks](https://github.com/gruntwork-io/runbooks/releases):

1. It reads `https://github.com/gruntwork-io/runbooks/releases.atom` to find the newest release.
2. It downloads that release's update file: `latest-mac.yml` on macOS, `latest.yml` on Windows or `latest-linux.yml` on Linux.

If that release is newer than yours, Runbooks tells you, downloads it from GitHub and asks whether to restart to install it. If you choose not to restart, the update installs when you quit.

These requests go to GitHub, not to Gruntwork. GitHub sees your IP address, as it does for any request. electron-updater also sends an `x-user-staging-id` header with a random ID that it creates once and keeps in a file named `.updaterId` in the Runbooks data folder. The ID is not derived from your machine or your account. GitHub counts how often each release file is downloaded, and Gruntwork can see those counts but not who made the downloads.

A build you run from source with `just dev` does not check for updates. There is no setting to turn the check off.

The update check is in [`electron/main/updater.ts`](https://github.com/gruntwork-io/runbooks/blob/main/electron/main/updater.ts).

## The `--no-telemetry` flag

Runbooks still accepts the `--no-telemetry` flag and the `RUNBOOKS_TELEMETRY_DISABLE` environment variable, so existing launch commands keep working. Neither has any effect, because there is nothing to turn off.
