# Documentation Rewrite Plan

Every documentation file that references Go, the HTTP server, CLI commands, build process, installation, or architecture needs updating.

## Priority 1: Root Files (block development)

These are read by every contributor and AI agent. Update first.

### `README.md`
| Section | Change |
|---------|--------|
| Building | Remove `go build`, replace with `just build` (electron-vite + electron-builder) |
| Development setup | Remove Go requirement. New prereqs: mise, just, then `mise install` for Node.js/bun. Remove `task dev:backend` / `task dev:frontend` split, replace with `just dev` |
| Security section | Localhost binding no longer applies (Electron IPC). Executable registry still applies. Rewrite trust model for desktop app context |
| Project description | Still accurate ("interactive MDX documents") but remove "self-contained binary" language, replace with "desktop application" |

### `AGENTS.md`
This is the most impactful file - AI agents and developers read it before every contribution.

| Section | Change |
|---------|--------|
| Project structure | Rewrite entirely. Remove Go backend description. Document `electron/`, `src/`, `cli/`, `web/` structure |
| Tooling conventions | Remove Go conventions. Add: electron-vite, oxlint, oxfmt, node-pty. Keep: bun, Vite, Vitest, Playwright |
| Key commands | Replace `task build`, `task dev:backend`, `task dev:frontend`, `task test:backend` with just recipes (`just dev`, `just build`, `just test`, `just lint`, `just fmt`) |
| Block conventions | Keep block authoring patterns (mostly unchanged). Update "how blocks communicate with backend" from HTTP/SSE to IPC |
| Testing | Update test commands. Remove Go test references. Document Vitest for unit tests, Playwright for E2E (with Electron support) |
| Architecture diagram | Rewrite: Electron main process → IPC → React renderer. Remove Gin HTTP server diagram |
| Error reporting | Update from HTTP error responses to IPC error handling |

## Priority 2: Docs Site - Installation & Commands (user-facing)

### `docs/intro/installation.mdx`
**Full rewrite.** Currently documents:
- Homebrew tap (`brew install gruntwork-io/tap/runbooks`)
- Pre-built binaries (darwin arm64/amd64, linux amd64/arm64, windows amd64)
- Building from source (`task build`)

Replace with:
- macOS: DMG download or Homebrew cask
- Linux: AppImage or .deb package
- Windows: NSIS installer
- Building from source: `bun install && bun run build`
- CLI test runner installation (separate binary)

### `docs/commands/overview.mdx`
**Rewrite.** CLI commands become app actions:
- `runbooks open` → Double-click app or `runbooks open <path>` via CLI integration
- `runbooks serve` → Removed (was for development only)
- `runbooks watch` → App menu option or CLI flag
- Remote URL support → Unchanged conceptually, update invocation examples

### `docs/commands/open.mdx`
**Major rewrite.** Currently documents CLI flags:
- `--working-dir` → App setting or dialog
- `--output-path` → App setting
- `--port` → Removed (no HTTP server)
- `--no-telemetry` → App setting or env var
- `--tf-runbook` → Removed (TfModule dropped)
- Remote source examples → Update from CLI to app

### `docs/commands/serve.mdx`
**Delete or archive.** The `serve` command was for development with a separate frontend. Not needed in Electron.

### `docs/commands/watch.mdx`
**Rewrite.** Watch mode becomes a toggle in the app rather than a separate CLI command.

## Priority 3: Docs Site - Security (trust model changes)

### `docs/security/execution-model.md`
**Significant rewrite.**
- Remove: "localhost-only binding" (no HTTP server)
- Remove: "session token authentication" and Bearer token details (IPC is process-local)
- Keep: Executable registry concept, trust model ("only open runbooks you trust")
- Add: Electron security model (sandboxed renderer, contextBridge, no nodeIntegration in renderer)
- Update: CSRF protection section (not applicable with IPC)

### `docs/security/shell-execution-context.md`
**Minor updates.** The execution model (persistent env, working directory, interpreter detection) is the same. Update:
- Remove references to "the server" or "backend HTTP handler"
- Update to reference "the main process" instead
- Env var behavior is identical, just the transport changes

### `docs/security/telemetry.md`
**Minor updates.** Same data collection, same Mixpanel backend. Update:
- `--no-telemetry` flag → App setting or env var
- Remove CLI-specific language

## Priority 4: Docs Site - Authoring (mostly unchanged)

### `docs/authoring/overview.md`
**No change.** Block authoring concepts are identical.

### `docs/authoring/runbook-structure.md`
**No change.** File format (runbook.mdx, assets/, scripts/, templates/) is identical.

### `docs/authoring/markdown.md`
**No change.**

### `docs/authoring/inputs-and-outputs.mdx`
**No change.** Variable wiring, inputsId, outputs are unchanged.

### `docs/authoring/boilerplate.md`
**Minor updates.** Boilerplate template syntax and boilerplate.yml format are unchanged. Update:
- Remove any references to "Go template engine" internals
- The WASM rendering is transparent to users - same template syntax, same variables

### `docs/authoring/opening-runbooks.mdx`
**Rewrite.** Opening method changes from CLI to desktop app. Update examples.

### `docs/authoring/testing.mdx`
**Moderate rewrite.** Test framework behavior is the same but invocation changes:
- `runbooks test` → `runbooks-cli test` (or whatever the Node.js CLI binary is named)
- `runbooks test init` → same with new binary name
- Test YAML format, assertions, steps → unchanged
- Installation of test CLI → new section

### Block documentation (10 files)
**Mostly unchanged.** Block props, behavior, and examples stay the same. Specific updates:

| File | Change |
|------|--------|
| `blocks/Check.md` | No change |
| `blocks/Command.mdx` | No change (env vars, file capture same) |
| `blocks/Inputs.mdx` | No change |
| `blocks/Template.mdx` | No change |
| `blocks/TemplateInline.mdx` | No change |
| `blocks/AwsAuth.mdx` | Minor: OAuth URL opens in system browser via Electron, not new tab |
| `blocks/GitHubAuth.mdx` | Minor: OAuth URL opens in system browser via Electron, not new tab |
| `blocks/GitClone.mdx` | No change |
| `blocks/GitHubPullRequest.mdx` | No change |
| `blocks/DirPicker.mdx` | Minor: Can use native OS directory picker dialog |
| `blocks/TfModule.mdx` | **Delete.** Feature dropped |
| `blocks/Admonition.md` | No change |
| `blocks/Advanced.md` | No change |

## Priority 5: Docs Site - Development

### `docs/development/workflow.md`
**Full rewrite.** Currently documents:
- Running Go backend (`go run main.go serve`) and React frontend (`bun dev`) separately
- Making changes to React components, Go handlers, runbook files
- Building (`task build`), testing (`task test`)

Replace with:
- Prerequisites: `mise install` (gets Node.js + bun), `bun install` (gets npm deps)
- Single command: `just dev` (electron-vite dev mode with HMR)
- Making changes to backend modules (`src/`), React components (`web/`), Electron main process (`electron/`)
- Building: `just build`, packaging: `just package`
- Testing: `just test` (all), `just test-unit` (Vitest), `just test-e2e` (Playwright)
- Code quality: `just lint` (oxlint), `just fmt` (oxfmt), `just typecheck` (tsc)
- All checks: `just check`

## Priority 6: Config Files

### `Taskfile.yml`
**Delete.** Replaced by `justfile`. See [electron-rewrite-tooling.md](./electron-rewrite-tooling.md) for the full justfile recipe mapping.

### `web/vite.config.ts`
**Replace** with `electron.vite.config.ts` at project root. Remove API proxy to localhost:7825.

### `vercel.json`
**No change** (docs site deployment, not the app).

### `docs/astro.config.mjs`
**Update sidebar.** Remove TfModule from sidebar items. Reorganize commands section if serve is removed.

## Priority 7: Cleanup

### `pr-description.md`
**Delete.** This is a stale PR description, not documentation.

### Testdata documentation
**Minor updates.** Feature demo READMEs may reference CLI invocation. Update:
- `testdata/feature-demos/tf-*` → Remove or archive (TfModule dropped)
- Other testdata → Update any `runbooks open`/`runbooks watch` invocations in READMEs

## Summary

| Priority | Files | Effort | Description |
|----------|-------|--------|-------------|
| 1 | 2 | High | README.md, AGENTS.md (contributor-facing) |
| 2 | 4 | High | Installation, CLI commands (user-facing) |
| 3 | 3 | Medium | Security model updates |
| 4 | 13 | Low | Authoring guides (mostly unchanged) |
| 5 | 1 | Medium | Development workflow |
| 6 | 3 | Medium | Config files |
| 7 | 2+ | Low | Cleanup of stale files |

**Total: ~28 files to update, 1 to delete (TfModule.mdx), 1 to delete (serve.mdx)**
