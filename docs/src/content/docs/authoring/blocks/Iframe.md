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
- `id` (string) - Block ID. Required with `outputs`, because later blocks read the page's outputs through it.
- `inputsId` (string or array) - [Inputs](/authoring/blocks/inputs/) block IDs whose values a local page receives. See [Exchanging values with a local page](#exchanging-values-with-a-local-page).
- `outputs` (array of strings) - Names of the outputs a local page may set, such as `outputs={["region"]}`. Names use letters, digits and underscores, and start with a letter or underscore.

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

## Exchanging values with a local page

A page from `assets/` can receive values from the runbook and send values back, so it can act as a custom form or picker. External sites can't do either, and setting `inputsId` or `outputs` on a block with an external `src` is a configuration error.

````mdx
<Inputs id="cluster">
```yaml
variables:
  - name: environment
    type: string
    default: staging
```
</Inputs>

<Iframe id="region-picker" src="./assets/picker/index.html" inputsId="cluster" outputs={["region"]} />

<Command id="deploy" command="./deploy.sh {{ .outputs.region_picker.region }}" />
````

### Receiving input values

With `inputsId`, the page receives the values of those Inputs blocks as a message. It arrives when the page loads, again whenever the values change, and whenever the page asks for it:

```js
window.addEventListener("message", (event) => {
  // Only the runbook sends input values. Another frame in the runbook, such
  // as an external site in a second Iframe block, can post to this page too.
  if (event.source !== parent) return
  if (event.data?.type === "runbooks:inputs") {
    console.log(event.data.inputs.environment) // "staging"
  }
})

// Ask for the current values, for example once a script loaded with `async` or `type="module"` is ready.
parent.postMessage({ type: "runbooks:get-inputs" }, "*")
```

A standalone `<Inputs>` block sends a change after the user clicks **Submit**.

### Setting outputs

The page sets outputs by posting a message to the runbook:

```js
parent.postMessage({ type: "runbooks:set-outputs", outputs: { region: "eu-west-1" } }, "*")
```

Later blocks read them like any block's outputs: `{{ .outputs.region_picker.region }}`, with hyphens in the block ID turned into underscores. Each message adds to or replaces the outputs the page set before. The block shows the current outputs under the frame.

The block refuses a whole message, and shows why under the frame, when any of these is true:

- It names an output that the `outputs` prop doesn't list.
- A value isn't a string.
- A value is longer than 65,536 characters.

The block only accepts messages from its own frame while that frame still shows a page from `assets/`. If the page navigates to another site, messages from that site are ignored and it receives no input values.

The page gets the input values it asks for, and it can send them anywhere. Only give a page the Inputs it needs.

To test a runbook whose later blocks read an Iframe's outputs, see [Testing Iframe Blocks](/authoring/testing/#testing-iframe-blocks).

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
