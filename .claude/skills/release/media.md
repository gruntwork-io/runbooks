# Capturing release media

Recordings and screenshots come from the built app, driven by a Playwright script. Scripts and output live in the scratchpad, not in the repo.

## Build the release commit

1. Add a worktree at the release commit.
2. `mise trust`, then `mise exec -- bun install --frozen-lockfile`.
3. `mise exec -- just fetch-boilerplate`. Without it every script block fails. Don't copy `resources/` from another checkout: it may hold a different boilerplate version.
4. `mise x node -- npx electron-vite build`. The app lands in `dist/main/index.js`.
5. If `node_modules/electron/dist` is missing, run `mise exec -- just _electron-binary`.

## Launch

Run a `.mjs` script with `mise x node -- node`. Load Playwright from the worktree (`createRequire(<worktree>/package.json)("@playwright/test")._electron`) and launch with:

```
args: [<worktree>/dist/main/index.js, "--use-mock-keychain", "--hide-scrollbars",
       "--user-data-dir=<temp dir>", <temp copy of the runbook dir>]
```

- **Pick the runbook** from `testdata/feature-demos/<feature>`: most features have a demo that records well as it is. Write a purpose-built demo in the scratchpad when none shows the feature clearly. Copy the runbook to a temp dir first, so sessions and generated files stay out of `testdata/`.
- **Keep personal details out.** Pass a sandboxed `HOME`, `SHELL=/bin/bash`, `TMPDIR=/tmp` and `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. `<Prerequisites>` reads PATH from a login shell, which would otherwise show tools under the real home.
- **Fix the look.** In the main process, set `nativeTheme.themeSource = "light"` and the window size. 1440×810 suits recordings. The title bar's step count needs a width of at least 1250. The Files panel stays collapsed at 1440×810.
- **Trust banner.** Click "I trust this Runbook", then wait for the button to detach: the banner fades for 1.25 s and holds its space until then. `isVisible({ timeout })` doesn't wait; use `waitFor({ state: "visible" })`.
- **Selectors.** `getByTestId(<block id>)` finds a block. A folded block shows a button named "Expand block".
- `page.viewportSize()` is null under Electron. Read `innerWidth` and `innerHeight` from the page.

## Screenshots

- One block or card: `locator.screenshot()`.
- Part of the page: `page.screenshot({ clip })` at 2x, content only, so stills match the recordings.
- A dialog: clip to `[data-slot=dialog-content]` plus a margin.
- The whole window with its frame and shadow: `screencapture -x -l <id>`, where the id is the middle field of `win.getMediaSourceId()`. It needs the terminal's Screen Recording permission, and the window must be focused first (`app.focus({ steal: true })`, `win.focus()`), or the traffic lights come out grey.

Set the scene before the shot:

- The first Template render marks every file as added. Click **Dismiss all** before changing inputs, so only the change you mean to show is highlighted.
- Any run rescans the files and re-opens the Files panel. Hide it again if it isn't the subject.
- Opening maximized logs focuses a button and pops its tooltip. Blur it.
- For a native file dialog, stub `dialog.showOpenDialog` in the main process to return the file.

## Recordings

Don't use `screencapture -V`: macOS draws a recording pill over the traffic lights and blackens the shadow.

1. **Capture** with CDP `Page.startScreencast` (jpeg, quality 92), acknowledging each frame and saving it with its timestamp.
2. **Show a pointer.** The screencast has none, so inject a fake cursor: a div that glides about 1.3 s to each target and pulses on click. Pause about 1.5 s after each action. A person must be able to follow what happened.
3. **Show keys.** Native accelerators such as Cmd+K don't fire from synthetic keys. Send the menu's IPC message from main (`menu:open-command-palette`) and show a keycap overlay.
4. **Encode** by resampling to a steady 30 fps: for each 1/30 s tick, hard-link the latest frame as `out%06d.jpg`, then `ffmpeg -framerate 30 -i out%06d.jpg -c:v libx264 -crf 20 -pix_fmt yuv420p <name>.mp4`. Don't use the concat demuxer with per-frame durations: it stretches the clip.

Keep a clip to one feature and under about 20 seconds.

## Blocks that need an account

To show an auth block signed in without a real account, launch a wrapper entry instead of `index.js`. Copy it next to `dist/main/index.js`; it patches `globalThis.fetch` (GitHub and GitLab validation) and `https.request` for `*.googleapis.com` to answer from an in-process stub, then does `await import("./index.js")`. GitLab detection reads `GLAB_CONFIG_DIR/config.yml` when `glab` isn't on PATH.
