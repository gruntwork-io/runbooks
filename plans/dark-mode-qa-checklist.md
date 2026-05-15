# Dark Mode — Manual QA Checklist

Phases 1–6 of `plans/dark-mode.md` are code-complete and pass all automated
checks (typecheck, lint, 543 backend + 314 web unit tests, 2 theme E2E tests,
production build). This checklist covers the **interactive visual pass** that
can't be automated — run it in the built app (`just dev` or a packaged build),
in **both light and dark**, plus **system** following an OS theme switch.

## Toggle mechanics

- [ ] Header → Menu → Theme: Light / Dark / System each apply immediately.
- [ ] Choice survives an app **restart** (not just reload).
- [ ] No flash of the wrong theme on cold launch (theme-init.js + the
      main-process `theme.json` restore should prevent it).
- [ ] `system` mode follows a live OS appearance change (no restart needed).
- [ ] Native chrome tracks the theme: window background on resize; on
      Windows/Linux the title-bar min/max/close overlay recolors. macOS traffic
      lights need no change.
- [ ] Favicon swaps with the theme (driven by `nativeTheme` → `prefers-color-scheme`).
- [ ] `Cmd/Ctrl+,` (Preferences) opens the Header menu where the toggle lives.

## App chrome & layout

- [ ] Header: logo (light variant in dark mode), file path, copy button, Menu.
- [ ] WelcomeScreen: logo, action cards, hover states, "CLI installed" badge.
- [ ] About dialog: colored logo variant, links.
- [ ] Error / warning banners (`ErrorSummaryBanner`, `WarningBanner`).
- [ ] `OpenUrlModal`, `GeneratedFilesAlert` dialog, `ViewContainerToggle`.
- [ ] Loading / error states in `App.tsx` (spinner, "Invalid Output Path",
      "Failed to Load Runbook").
- [ ] `ExecutableRegistryContext` error + loading screens.

## MDX components — check both themes

- [ ] **Command** — idle / running / pass / fail states; the inline command
      preview block is a deliberately dark terminal surface in *both* themes.
- [ ] **Check** — pass / fail / running; same dark terminal preview note.
- [ ] **Admonition** — all four variants stay visually distinct: note (muted),
      info (blue), warning (amber), danger (red).
- [ ] **AwsAuth** — status surfaces (authenticated/failed/authenticating/
      pending/select-account/role), the AWS logo (white wordmark in dark mode),
      credentials & profile & SSO flows.
- [ ] **GitHubAuth** — the former violet brand now uses the `info` token;
      OAuth + PAT flows, AuthTabs, success state.
- [ ] **GitHubPullRequest** — PR form, label selector, markdown editor +
      preview, PR result.
- [ ] **GitClone** — clone form, GitHub browser, progress, clone result.
- [ ] **DirPicker**, **Template**, **TemplateInline**.
- [ ] `_shared`: FormControls, FormStatus, ErrorDisplay, SuccessIndicator,
      ViewOutputs, ViewLogs (dark terminal panel), ViewSourceCode, CodeBlock,
      BoilerplateInputsForm, the Unmet*DependencyWarning banners.

## Artifacts panel

- [ ] `ChangedFilesView` — diff colors: additions green/`success`, deletions
      red/`destructive`, modified amber/`warning`; before/after labels.
- [ ] `FileTree` — selected/hover rows; OpenTofu/Terragrunt icons use
      `currentColor` so they're visible in dark mode.
- [ ] `CodeFile*`, `CheckSummary`, `CommandSummary`, `Workspace`,
      `RepositoryFileBrowser`, `RepositoryTabs`, `ContextSwitcher`, the worktree
      rows, metadata bars, `ChangeProportionBar`.

## Rendered runbook markdown

- [ ] Markdown body (`github-markdown.css`) switches with the in-app theme —
      headings, links, tables, blockquotes, inline `code`, fenced code blocks
      with syntax highlighting, images.
- [ ] No flash of light markdown when opening a runbook in dark mode.

## Known/intentional items (not bugs)

- Terminal-output surfaces in Command/Check/ViewLogs stay dark in both themes
  by design (consistent with `TerminalText.css`'s One Dark palette).
- Two base64-encoded SVG icons in `headless-tree.css` (a drag-handle, the
  folder arrow) keep hardcoded fills — can't theme inside a data URI without
  re-encoding. Tiny icons; low priority.
- GitHub's violet and AWS's amber/purple brand colors were collapsed to the
  `info` / `warning` semantic tokens (no dedicated brand token added).

## Contrast spot-check (WCAG AA)

Approximate, from the OKLCH lightness of the token pairs:

- Core neutrals pass comfortably: `foreground` on `background` ≈ 18–19:1 both
  themes; `muted-foreground` on `background` ≈ 4.6:1 (light) / 7:1 (dark).
- ⚠️ Colored text on `*-muted` surfaces is **borderline** for normal-size text:
  `text-success` on `bg-success-muted` ≈ ~3.8:1 (light). This matches the
  original Tailwind `text-green-600`/`bg-green-50` it replaced — not a
  regression — but if a stricter bar is wanted, darken the `*-muted`
  foregrounds or lighten the `*-muted` surfaces in `web/src/css/App.css`.
- `warning-foreground` on `warning-muted` was tuned for this and passes well
  (~7:1+ both themes).
