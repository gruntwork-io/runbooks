---
title: <Iframe>
---

The `<Iframe>` block embeds a web page in your runbook. It can show an external site, such as a dashboard or a local dev server, or an HTML page that ships with the runbook in its `assets/` folder.

The page doesn't load when the runbook opens. The block shows a **Load page** button, so a runbook can't run its author's scripts until the user asks for it. Once loaded, the page stays loaded until the app quits, including across live reloads while you edit the runbook.

The page runs as a separate page with its own browser session, not as part of the runbook. It can't read what you type into the runbook's other blocks, and it has no access to the Runbooks app.

## Basic Usage

Embed an external site:

```mdx
<Iframe src="https://runbooks.gruntwork.io/authoring/blocks/command/" title="Command block docs" />
```

Embed a page from the runbook's `assets/` folder:

```mdx
<Iframe src="./assets/dashboard/index.html" title="Deployment dashboard" height={600} />
```

## Props

### Required Props

- `src` (string) - The page to load: an `https://` URL, an `http://` URL on `localhost` or `127.0.0.1` (such as a local dev server), or a path that starts with `./assets/` for a file in the runbook's `assets/` folder.

### Optional Props

- `title` (string) - Label shown above the frame. Screen readers announce it too. The title bar always shows the frame's host, or its `./assets/` path, next to the label.
- `height` (number or string) - Height of the frame. A number, or a string of digits, is a pixel count (`height={600}` or `height="600"`). Any other string must be a CSS length (`height="70vh"`). Defaults to 500 pixels.

The frame always fills the width of the runbook.

## Local pages

A local page loads with every file it references, so a static site built into a folder works as long as it sits under `assets/`:

```
my-runbook/
├── runbook.mdx
└── assets/
    └── dashboard/
        ├── index.html
        ├── app.js
        └── style.css
```

Relative references such as `<script src="app.js">` or `href="./style.css"` resolve against the page's own folder. A path that starts with `/` resolves against the `assets/` folder instead, so `/app.js` in the example above loads `assets/app.js`, not `assets/dashboard/app.js`. Build the site with relative paths. For a Vite build, set `base: './'`.

A local page can only load files inside the runbook's `assets/` folder. It can't read `runbook.mdx`, generated files, or anything else in the runbook's folder. It can link to other pages in `assets/`, but not navigate to an external site.

`assets/` must be a real folder. If `assets` is a symlink, Runbooks serves nothing from it, so local pages, images and videos all fail to load. A symlink to a file inside `assets/` works as long as it points to another file inside `assets/`.

Each runbook's local pages get their own origin. A page can keep data in `localStorage` or other browser storage, and it's still there the next time the runbook opens, but pages from other runbooks can't read it.

## External sites

An external page can navigate to other `https://` pages, and to `http://` pages on `localhost` or `127.0.0.1`. It can't load files from the runbook's `assets/` folder.

External pages share one browser session, kept between app restarts, so signing in to a site in one runbook signs you in wherever it's embedded. That session is separate from your web browser's.

The page runs as a page of its own, not inside the runbook's, so sites that forbid framing with an `X-Frame-Options` or `Content-Security-Policy: frame-ancestors` header still load.

## Behavior

- The title bar shows the host the frame started on. The page can navigate itself elsewhere after it loads.
- A host too long for the title bar is shortened from the start, so its end, which names the site, stays visible.
- The title bar has a **Reload** button that loads `src` again, and for external sites an **Open in browser** button.
- The embedded page gets keyboard input only after you click into it. It can't move focus into itself while you type elsewhere in the runbook.
- The embedded page can't open new windows. Links with `target="_blank"` and calls to `window.open` do nothing. Use the **Open in browser** button to open an external site in your default browser.
- The embedded page can't show dialogs or start downloads. `alert()`, `confirm()` and `prompt()` return at once, and a download is cancelled.
- The embedded page runs its own scripts, but it can't navigate the runbook away or call into the Runbooks app.
- The embedded page gets no browser permissions. Requests for the microphone, camera, location, notifications, fullscreen, USB devices and the like are denied without asking.
- Runbooks never sends a client certificate, so a site that requires one to sign in won't load.
