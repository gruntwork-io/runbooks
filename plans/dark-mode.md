# Dark Mode Implementation Plan

Status: Phases 1-6 complete — code-complete, pending interactive visual QA
        (see plans/dark-mode-qa-checklist.md)
Scope: `web/` renderer + `electron/` native chrome

## Goal

Add a user-controllable theme (`light` / `dark` / `system`) to the Runbooks
desktop app, persisted across launches, with no flash-of-wrong-theme on startup
and correct native window chrome on every platform.

## Current state

The theming *infrastructure* already exists; almost nothing uses it.

- `web/src/css/App.css` already declares `@custom-variant dark (&:is(.dark *))`
  and a full `.dark { ... }` block (App.css:91-123) with dark values for every
  shadcn semantic token (`--background`, `--foreground`, `--card`, `--muted`,
  `--border`, etc.).
- **Nothing ever applies the `.dark` class.** There is no theme state, no
  toggle, no persistence.
- **~1,268 hardcoded color utility classes** (`text-gray-500`, `bg-gray-100`,
  `bg-red-50`, …) across **77 of 108 `.tsx` files**. Tailwind's `dark:` variant
  does nothing for these — they stay light in dark mode.
- The semantic token set is **missing success / warning / subtle-destructive
  tokens**, so greens, ambers and `bg-red-50`-style backgrounds have nowhere to
  map to yet.
- `--color-bg-default` is hard-coded in the `@theme` block (App.css:8-11), not
  in the `:root` / `.dark` variable pair, so `body`'s background can't flip.
- Markdown content is styled by copied GitHub CSS: `github-markdown.css` (base,
  already supports `[data-theme="dark"]`), `github-markdown-light.css` (forces
  light unconditionally — imported), `github-markdown-dark.css` (exists, **not
  imported**).
- Three non-Tailwind CSS files hardcode colors: `headless-tree.css`,
  `TerminalText.css` (already dark-oriented), `css/index.css`.
- Electron `window.ts` hardcodes `titleBarOverlay` colors (`#FAF9F5` /
  `#6B7280`) and sets no `backgroundColor`. A `menu:preferences` event is
  already *sent* from `menu.ts:97` but is not wired into the preload allowlist
  or `IpcEventMap` — a ready-made hook point.

## Architecture decisions

1. **Renderer is the source of truth.** Theme preference lives in
   `localStorage` under a single key. This avoids an IPC round-trip on every
   read and lets a tiny inline script apply the theme before React mounts.
2. **No flash of wrong theme.** An inline `<script>` in `index.html` reads
   `localStorage` (falling back to `prefers-color-scheme`) and sets
   `documentElement.classList` *before* the bundle loads.
3. **`.dark` class on `<html>`** (`document.documentElement`), matching the
   `&:is(.dark *)` custom variant.
4. **One new invoke channel** — `native:set-theme` — pushes the *effective*
   theme to the main process so it can update `nativeTheme.themeSource` and
   `titleBarOverlay` colors. The renderer still works without it (web preview).
5. **`system` mode** resolves via `window.matchMedia('(prefers-color-scheme:
   dark)')`; the listener updates the `.dark` class live when the OS theme
   changes.
6. **Migrate to semantic tokens, not inline `dark:` variants.** Converting
   `text-gray-500` → `text-muted-foreground` is the correct long-term fix and
   keeps the diff reviewable. Inline `dark:` variants are a fallback only for
   genuinely one-off colors.

## Phase 1 — Theme infrastructure (foundation)

No visual change yet; this makes a theme *switchable*.

### 1a. Extend the token set (`web/src/css/App.css`)

The current `:root` / `.dark` blocks lack semantic colors for the most common
hardcoded families. Add paired tokens (light value in `:root`, dark value in
`.dark`) and expose them in the `@theme inline` block:

- `--success` / `--success-foreground` / `--success-muted` (greens — 35×
  `text-green-600`, 15× `border-green-200`, …)
- `--warning` / `--warning-foreground` / `--warning-muted` (ambers/yellows —
  `text-amber-800`, `bg-yellow-100`, …)
- `--destructive-muted` (subtle red backgrounds — 37× `bg-red-50`, 32×
  `bg-red-100`, 25× `border-red-200`)
- `--info` / `--info-muted` if blues need to be distinct from `--primary`
  (17× `ring-blue-500`, 17× `bg-blue-50`, 13× `bg-blue-100`)

Move `--color-bg-default` out of the static `@theme` block: define
`--bg-default` in `:root` and `.dark`, then `--color-bg-default:
var(--bg-default)` in `@theme inline`.

### 1b. FOUC-prevention script (`web/index.html`)

Add an inline `<script>` in `<head>` (before the module script) that reads the
`localStorage` theme key, resolves `system`, and toggles
`document.documentElement.classList`.

### 1c. Theme context (`web/src/contexts/ThemeContext.tsx` + `useTheme.ts`)

- State: `theme: 'light' | 'dark' | 'system'` and derived `resolvedTheme`.
- `setTheme()` writes `localStorage`, toggles the `.dark` class, and (if
  `window.api` exists) calls `api.invoke('native:set-theme', …)`.
- A `matchMedia` listener keeps `system` live.
- Provider added to `web/src/main.tsx` (outermost or just inside `StrictMode`).

### 1d. IPC channel (`electron/`)

- `electron/shared/channels.ts`: add
  `"native:set-theme": { params: { theme: 'light'|'dark'|'system' }; result: { ok: true } }`
  to `IpcChannelMap`; add `"menu:preferences": void` and (optional)
  `"menu:toggle-theme": void` to `IpcEventMap`.
- `electron/preload/index.ts`: add the channel names to `ALLOWED_INVOKE_CHANNELS`
  / `ALLOWED_EVENT_CHANNELS`.
- `electron/main/ipc/` (new `theme.ts` or fold into `runtime.ts`): handle
  `native:set-theme` → set `nativeTheme.themeSource` and call the window helper
  to update `titleBarOverlay`.
- `electron/main/window.ts`: add `backgroundColor` to `BrowserWindow` options
  and a `setTitleBarTheme(effective)` helper that swaps the overlay colors
  (light: `#FAF9F5` / `#6B7280`; dark values from the `.dark` token set).
- `electron/main/menu.ts`: the `menu:preferences` send already exists; verify
  it reaches the renderer once the channel is allowlisted. Optionally add a
  "View → Toggle Theme" item.

### 1e. Toggle UI

- New `web/src/components/ui/theme-toggle.tsx` (or
  `components/layout/ThemeToggle.tsx`) — a 3-way control using `lucide-react`
  `Sun` / `Moon` / `Monitor` icons.
- Mount it in the `DropdownMenu` in `web/src/components/layout/Header.tsx:153`
  (next to "About"), and respond to the `menu:preferences` event in `App.tsx`.

**Phase 1 exit criteria:** toggling theme flips `.dark` on `<html>`, persists
across reload, no startup flash, native title bar updates. Components that
already use semantic tokens (the `ui/` primitives) look correct in both themes;
the rest of the app is still visually light.

## Phase 2 — Token migration (the bulk of the work)

Convert hardcoded color utilities to semantic tokens. Work in dependency order,
smallest-blast-radius first, visually QA each batch in both themes before
moving on.

### Token mapping reference

| Hardcoded | Semantic token | Count (approx) |
|---|---|---|
| `text-gray-500` / `-600` / `-400` | `text-muted-foreground` | ~340 |
| `text-gray-700` / `-900` | `text-foreground` | ~120 |
| `text-gray-300` | `text-muted-foreground` (or `/50`) | ~14 |
| `border-gray-200` | `border-border` | 67 |
| `border-gray-300` | `border-input` | 58 |
| `bg-white` | `bg-card` / `bg-background` | 35 |
| `bg-gray-50` / `bg-gray-100` | `bg-muted` / `bg-accent` | ~105 |
| `text-red-600` / `-500` / `-700` | `text-destructive` | ~84 |
| `bg-red-50` / `bg-red-100` | `bg-destructive-muted` | ~69 |
| `border-red-200` | `border-destructive/30` | 25 |
| `text-green-600` / `border-green-200` | `text-success` / `border-success/30` | ~50 |
| `text-amber-*` / `bg-yellow-100` | `text-warning` / `bg-warning-muted` | ~55 |
| `text-blue-600` / `bg-blue-50` / `ring-blue-500` | `text-primary` / `bg-info-muted` / `ring-ring` | ~70 |
| `text-white` | `text-primary-foreground` (context-dependent) | 15 |

`bg-gray-100` vs `bg-gray-50` etc. require judgement — is it a card, a muted
panel, or a hover state? Don't blind-replace; read the component.

### Batches

1. **shadcn primitives** — `web/src/components/ui/**` (`button/`, `checkbox`,
   `dropdown-menu`, `dialog`, `alert-dialog`, `popover`, `tooltip`, `tabs`,
   `collapsible`, `command`, `ResizeHandle`). Small, high-leverage, mostly
   already token-based — finish anything that isn't.
2. **Layout** — `App.tsx`, `components/layout/**` (`Header`, `WelcomeScreen`,
   `ErrorSummaryBanner`, `ArtifactsContainer`, `WarningBanner`,
   `GeneratedFilesAlert`, `OpenUrlModal`, `ViewContainerToggle`).
3. **MDX shared** — `components/mdx/_shared/**` (`FormControls.tsx` is 44
   hits, `ViewOutputs.tsx`, `SuccessIndicator`). These are reused everywhere,
   so they unlock the rest.
4. **MDX components** — `components/mdx/**`: `Command`, `Check`, `GitClone`,
   `AwsAuth`, `GitHubAuth`, `GitHubPullRequest`, `Admonition`, `DirPicker`,
   etc. The long tail; ~30 files.
5. **Artifacts** — `components/artifacts/**` (`ChangedFilesView.tsx` is the
   single biggest file at 52 hits, `workspace/`, `code/`, `checks/`,
   `commands/`).
6. **App.css component layer** — `.runbook-block input { background-color:
   white }` (App.css:181) and any other literal colors → tokens.

### Method per file

- `grep -nE '\b(bg|text|border|ring|divide|from|to|via)-(gray|white|black|blue|red|green|yellow|amber|slate|zinc|neutral|emerald|orange)' <file>`
- Replace per the mapping table, using judgement for ambiguous greys.
- Render the component in both themes (Storybook-less: use the running app +
  the toggle, or a temporary `.dark` on `<html>` via devtools).
- Keep batches as separate commits for reviewability.

## Phase 3 — Non-Tailwind CSS

- **`github-markdown-*.css`** — stop importing `github-markdown-light.css`
  unconditionally. Options: (a) gate its `.markdown-body` selectors under
  `html:not(.dark)` and import `github-markdown-dark.css` gated under
  `html.dark`; or (b) set `data-theme={resolvedTheme}` on the `.markdown-body`
  divs in `MDXContainer.tsx` (the base file already honours
  `[data-theme="dark"]`). Prefer (b) — least edited copied code.
- **`headless-tree.css`** — replace literal hex/hsl (`--selected-color`,
  `#e1f1f8`, `#e1f8ff`, `black`, `#808080`, `#393939`, `#f6f6f6`, `#0366d6`,
  `#eee`) with `var(--…)` semantic tokens. Used by `FileTree.tsx` /
  `RepositoryFileBrowser.tsx`.
- **`TerminalText.css`** — One Dark palette, already dark-oriented. Verify
  contrast on a *light* terminal surface; adjust the surface, not necessarily
  the ANSI colors.
- **`css/index.css`** — no colors today; leave or fold into App.css.
- **`SuccessIndicator.module.css`**, **`MarkdownEditor.css`** — animations /
  layout only, no color work needed (confirm).

## Phase 4 — Assets

- `web/src/assets/runbooks-logo-dark-*.svg` are *dark-colored* logos for light
  backgrounds. Add light-colored variants and switch in `Header.tsx` (and the
  About dialog) based on `resolvedTheme`.
- Favicons in `index.html` already swap on `prefers-color-scheme` — verify they
  also track the in-app override, or accept OS-driven favicon as good enough.
- `aws-logo.svg` / `GitHubIcon` — check they're visible on dark surfaces.

## Phase 5 — Native chrome (Electron)

Covered structurally in Phase 1d; finish and verify:

- `titleBarOverlay` color swap on Windows/Linux when theme changes.
- `BrowserWindow.backgroundColor` set to the resolved theme's background so
  resize/launch doesn't flash white.
- `nativeTheme.themeSource` driven by the renderer's choice so `system` mode is
  truly OS-following.
- macOS traffic lights need no work (`titleBarStyle: hiddenInset`).

## Phase 6 — Testing & QA

- **Unit** — `ThemeContext.test.tsx`: default resolution, `localStorage`
  persistence, `system` + `matchMedia` changes, class toggling. Follow the
  existing `web/src/test/` + `test-utils/mock-api.ts` patterns.
- **Mock API** — extend `test-utils/mock-api.ts` to stub `native:set-theme`.
- **E2E** — a Playwright spec (`web/e2e/` or `electron/e2e/`) toggling theme
  and asserting the `.dark` class + persistence across reload.
- **Visual QA checklist** — every MDX component, both themes: `Command` output,
  `Check` pass/fail states, `AwsAuth` / `GitHubAuth` flows, `GitClone`
  progress, `GitHubPullRequest`, `Admonition` (all severities),
  `ChangedFilesView` diff colors, `FileTree`, error/warning banners, dialogs,
  tooltips, dropdowns, `WelcomeScreen`.
- **Contrast** — spot-check WCAG AA on muted-foreground text in both themes.

## Effort estimate

| Phase | Effort |
|---|---|
| 1 — infrastructure (tokens, context, IPC, toggle, FOUC) | ~1 day |
| 2 — token migration (~1,268 classes, 77 files) | ~3–5 days + QA |
| 3 — non-Tailwind CSS | ~0.5 day |
| 4 — assets | ~0.5 day |
| 5 — native chrome | folded into Phase 1, ~few hrs to finish |
| 6 — testing & QA | ~1 day |
| **Total** | **~6–8 days** |

## Incremental shipping option

Phase 1 + the `ui/` primitives batch of Phase 2 produces a *working* toggle
where dialogs, menus and form primitives are correct. The app can ship that
behind the toggle and migrate the remaining component batches over subsequent
PRs — each batch is independently reviewable and shippable.

## Risks / watch-items

- **Ambiguous greys** — `bg-gray-100` is sometimes a surface, sometimes a hover
  state, sometimes a disabled state. Mechanical replace will get some wrong;
  budget QA time.
- **Third-party / copied CSS** — editing the GitHub markdown files makes future
  re-syncs harder; prefer the `data-theme` attribute approach over editing
  selectors.
- **`StrictMode` double-invoke** — the `matchMedia` listener and class toggling
  must be idempotent.
- **`runbook-block input { background-color: white }`** and similar literal
  colors lurking in component-layer CSS will be easy to miss — grep for `white`
  / `#fff` / hex literals across all `.css`.
- **Telemetry** — out of scope; per project memory, telemetry is not a
  priority, so don't add theme-change events.
