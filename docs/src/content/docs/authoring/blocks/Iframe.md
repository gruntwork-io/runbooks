---
title: <Iframe>
---

The `<Iframe>` block embeds a web page in your runbook. It can show an external site, such as a dashboard or a local dev server, or an HTML page that ships with the runbook in its `assets/` folder.

The page doesn't load when the runbook opens. The block shows a **Load page** button, so a runbook can't run its author's scripts until the user asks for it. Once loaded, the page stays loaded until the app quits, including across live reloads while you edit the runbook.

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
- `height` (number or string) - Height of the frame. A number is a pixel count (`height={600}`). A string can be any CSS length (`height="70vh"`). Defaults to 500 pixels.

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

A local page can only load files inside the runbook's `assets/` folder. It can't read `runbook.mdx`, generated files, or anything else in the runbook's folder.

Each runbook's local pages get their own origin. A page can keep data in `localStorage` or other browser storage, and it's still there the next time the runbook opens, but pages from other runbooks can't read it.

## Sites that refuse to be embedded

Many sites send an `X-Frame-Options` or `Content-Security-Policy: frame-ancestors` header that forbids other pages from framing them. For those sites the frame shows an error instead of the page. Runbooks respects the header. Link to the site instead, or use the **Open in browser** button in the frame's title bar.

## Behavior

- The title bar shows the host the frame started on. The page can navigate itself elsewhere after it loads.
- A host too long for the title bar is shortened from the start, so its end, which names the site, stays visible.
- The title bar has a **Reload** button that loads `src` again, and for external sites an **Open in browser** button.
- The embedded page can't open new windows. Links with `target="_blank"` and calls to `window.open` do nothing. Use the **Open in browser** button to open an external site in your default browser.
- The embedded page runs its own scripts, but it can't navigate the runbook away or call into the Runbooks app.
- The embedded page gets no browser permissions. Requests for the microphone, camera, location, notifications, fullscreen and the like are denied without asking.
- Runbooks never sends a client certificate, so a site that requires one to sign in won't load.
