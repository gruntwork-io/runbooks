# Plan: Implement `BoilerplateRenderer.renderTemplate`

## Goal

Replace the stub at `src/layers/WasmBoilerplate.ts:186-188` with a working implementation that walks a template directory, renders every file (and templated path segments) via the existing Go-template engine, and writes the results to an output directory. The IPC handler (`electron/main/ipc/boilerplate.ts:125`) already takes care of manifest, diff, and orphan cleanup — so `renderTemplate` just needs to produce correct files on disk.

## Contract (what callers expect)

```ts
renderTemplate(
  templateDir: string,      // absolute path to template dir with boilerplate.yml
  outputDir: string,         // absolute path; may or may not exist yet
  variables: Record<string, unknown>,  // shape: { inputs: {...}, outputs: {...} }
) => Effect.Effect<void, RenderError>
```

- Must create `outputDir` if it does not exist.
- Must not delete orphaned files — the caller already handles that via `computeDiff`.
- Must not throw on empty templates; a dir with only `boilerplate.yml` produces no files but no error.
- Must be deterministic (same inputs → same output bytes) so `computeDiff` correctly identifies unchanged files.

## Required capabilities — grouped by priority

Features are graded by whether a **failing E2E test** hits them. The fixtures that drive the tests use concrete template patterns that let us scope the work precisely.

### P0 — blocks the 3 failing tests

1. **Recursive walk of `templateDir`**, skipping `boilerplate.yml` / `boilerplate.yaml` at every level. Use `FileSystem.readdirWithTypes` for the traversal and `FileSystem.readFile` / `FileSystem.writeFile` for content. No special cases for hidden files — `.gitignore` ships as a real output file in `demo2/templates/infra-live-elements/`.
2. **Templated path segments** in both filenames and directory names. All four failing-test fixtures use `{{ .inputs.RootTerragruntFileName }}` as a filename; other fixtures use `{{ .inputs.DefaultRegion }}` as a directory. Render each segment with the existing `renderGoTemplate` before creating the path on disk. An empty rendered segment should be treated as "skip this file" (matches Go boilerplate semantics and mirrors `skip_files`).
3. **Reuse `renderGoTemplate` for file contents** — unchanged. All current content features (`{{ .path }}`, truthy `{{ if }}`, whitespace trim `{{- -}}`, etc.) keep working.
4. **`range` over plain maps and arrays without `fromJson`**. Every fixture template uses the bare form: `{{- range $k, $v := .inputs.AWSAccounts }}...{{- end }}`. The current regex requires `(fromJson .path)` — that's why `accounts.yml` would render garbage even if we just shipped the walker. Extend the range regex to accept either form: optional `(fromJson ...)` wrapper OR bare `.path`. When the variable is already a plain object/array (which is the case for all real-world usage in fixtures), skip the JSON parse. Keep `fromJson` support for backward compat.
5. **Empty parent directories** — `FileSystem.mkdir` with `recursive: true` before each write.
6. **Root-scoping guard**: never let a templated path segment resolve outside `outputDir` (prevents `../../` escapes from pathological variables). Cheap check: after join, assert `resolved.startsWith(outputDir + path.sep)`.

### P1 — needed for correct content on fixtures we render (and to match what callers already ship in production runbooks)

7. **`eq` / `ne` / `not` / `and` / `or` inside `{{ if }}`**. The `my-first-runbook` README contains `{{ if eq .inputs.Language "Go" -}}...{{- else if eq .inputs.Language "Python" -}}...{{- end }}`. The failing test only substring-asserts "test-project" and "Alice", so this block can render to garbage and the test still passes — but shipping a README with literal `{{ if eq ... }}` text is a correctness bug. Add a small pratt-style expression evaluator or a regex-pass that handles these predicates. Scope: the operand forms actually used are `eq .x "literal"`, `ne .x "literal"`, `not .x`, and `or (...) (...)`.
8. **`else if` chains.** Same template. The current `if`-regex captures exactly one else-branch; extend it to parse `{{ else if ... }}` into a chain. Simplest path: a small hand-rolled block parser that walks `{{ if }}` / `{{ else if }}` / `{{ else }}` / `{{ end }}` tokens with proper nesting — regex is too fragile once chains appear.
9. **Pipe `|` with a small function table** — at minimum `printf`, since `accounts.yml` has `{{ $value | printf "%q" }}`. Without it, the rendered YAML has literal `|` operators in its body. A conservative implementation: after substituting `$value`, apply pipelined functions left-to-right over the rendered string. Only `printf "%q"` (quote a value) is needed for the fixtures; add a tiny table (`printf`, `quote`, `upper`, `lower`, `hasPrefix`, `hasSuffix`, `default`) and return the input unchanged for unknown functions so we never crash on an unfamiliar template.

### P2 — feature parity with upstream Gruntwork boilerplate, not required by current tests

10. **`skip_files:` with `if:` conditions.** Not used by any fixture under the failing tests, but widely used by real infra-live templates. Parse once up-front (add to `parseBoilerplateConfig`), evaluate each entry as a Go template that returns truthy/falsy, and omit the file from the walk.
11. **`dependencies:` / sub-template rendering.** Also not hit by failing tests. The fixtures under `demo2/templates/_gruntwork-landing-zone/` and `_infra-live-root/` exist as sub-templates but aren't invoked by the failing `infra-live-elements` render. Defer — document as known gap with a clear error if `dependencies:` is present.
12. **`hooks:` (before/after).** Out of renderer scope; runs commands on the host. Defer.
13. **Backward-compat root aliasing** (`{{ .Name }}` equivalent to `{{ .inputs.Name }}`). The Go backend has this; TS implementation does not. Low priority — none of the fixtures use it — but cheap to add: shallow-merge `variables.inputs` into the top-level render context.

### Features the current `renderFile` already gets right (no work needed)

- `{{ .a.b.c }}` dot paths
- `{{ if .path }}...{{ else }}...{{ end }}` truthy branches
- `{{ range $item := ... }}` single-var iteration
- Whitespace trimming `{{- / -}}`
- Nested `range` over `$value.field`
- `fromJson` / `toJson`

## Implementation phases

Ship this in three PRs so each lands with a tight test signal.

**PR 1 — walker + plain-map range + filename templating (P0 items 1-6).**
Gets all three failing tests passing for the simple assertions. One new file (`renderTemplate` in `WasmBoilerplate.ts`), one existing regex tweak (range without `fromJson`). Add unit tests under `src/__tests__/` or wherever renderFile tests live — cover: empty dir, single file, templated filename, nested templated dirs, skip `boilerplate.yml`, scope escape rejected.

**PR 2 — template engine extensions (P1 items 7-9).**
Replace the regex-based `if` / `range` handling with a small block-parser that tokenizes `{{ ... }}` runs and evaluates them. This is where the engine actually matures from "regex hacks" to "scaled-down interpreter." Add a function table for pipe support and `eq`/`ne`/`not`. Unit-test each operator and the else-if chain explicitly against the real `my-first-runbook/README.md` and `demo2/accounts.yml` content.

**PR 3 (optional) — `skip_files` + config-level features (P2 item 10).**
Extend `parseBoilerplateConfig` to surface `skip_files`. Thread into the walker. Unit-test one truthy skip, one falsy skip, one nonsense expression (should log + keep file).

## File-level changes

- `src/layers/WasmBoilerplate.ts` — replace stub; consider splitting into `renderContent` (existing), `renderPathSegment` (new), and `renderTemplate` (walker).
- `src/services/BoilerplateRenderer.ts` — no type changes needed; the signature already fits.
- `src/domain/boilerplate/config.ts` — in PR 3, add `skip_files` parsing + type. No change in PR 1-2.
- `src/types.ts` — in PR 3, add `skipFiles: Array<{path: string; if?: string}>` to `BoilerplateConfig`.
- New tests: `src/layers/__tests__/WasmBoilerplate.renderTemplate.test.ts` (if that's the test-layout convention; otherwise follow whatever pattern already exists for `renderFile`).
- `electron/main/ipc/boilerplate.ts` — **no changes expected**. The handler already calls `renderTemplate` correctly and builds manifests after. Verify this holds once PR 1 is in.

## Risks & open questions

- **Silent mis-rendering.** The E2E tests only substring-assert outputs. It's possible the renderer produces broken YAML/HCL with extra newlines or stray literal `{{ ... }}` and the tests still go green. Mitigation: for P1, add unit tests that snapshot-compare the full rendered file against a golden fixture for at least one of `accounts.yml`, `common.hcl`, and `README.md`. Golden fixtures can be generated once by hand and checked in.
- **Binary files.** The walker currently reads as string. All template fixtures are text, but the `next-app/empty-repo/.git/...` pack files show binary content exists nearby. Should we treat the template dir as text-only? Safe default: skip non-UTF-8 files with a warning, or use `readFileBuffer` and only run templating when content contains `{{`. Cheaper heuristic: check extension against a denylist (`.pack`, `.idx`, `.png`, `.jpg`) — but that's a trap waiting to bite us. Prefer: read as text, fall back to copying bytes on decode failure.
- **Range over object vs array ordering.** JS `Object.entries` preserves insertion order; Go's `range` over a `map` does not. The fixtures likely don't care, but `accounts.yml` key order is user-visible. Document "insertion order" as the contract; don't sort alphabetically.
- **Variable scoping on nested `range`.** Current `renderGoTemplate` handles `$value.field` but nested iterations reset regex state in tricky ways. PR 2's block-parser should represent scopes as a stack rather than a flat substitution — otherwise `range` inside `range` inside `if` will misbehave on real templates.
- **Effect error channel.** Wrap I/O errors as `RenderError` with a path in the message. The IPC surface already turns failures into the "IPC call to boilerplate:render failed" banner the E2E traces showed — so messages should be user-friendly, not stack traces.
- **Deprecation of `fromJson`-wrapped range.** Keep it working indefinitely; some older runbooks may ship with it.

## Test strategy

- **Unit**: per-feature, using in-memory FS mock or `tmpdir` fixtures. One test per P0 capability, one per P1 extension.
- **Integration**: render each of the three failing-test template dirs and assert byte-for-byte output against a golden. This catches silent mis-rendering that substring assertions miss.
- **E2E (existing)**: the three failing tests in `web/e2e/test-sample-runbooks.spec.ts` become the acceptance gate — all three should turn green after PR 1, and stay green through PR 2 and PR 3.

## Rough effort estimate

- PR 1: 0.5–1 day. Mostly file walking + one regex tweak + test scaffold.
- PR 2: 1–2 days. The block parser is where this bucket earns its name — don't underestimate `else if` + nesting edge cases.
- PR 3: 0.5 day, only if needed.

## Acceptance criteria

- `web/e2e/test-sample-runbooks.spec.ts` tests green (after PR 1):
  - `sample-runbooks/demo2 › renders the large input form and generates files`
  - `sample-runbooks/demo3 › generates files from Template block and shows them in file panel`
  - `sample-runbooks/my-first-runbook › generates template files and shows them in the file panel`
- Byte-for-byte golden snapshots match (after PR 2) for:
  - `demo2/templates/infra-live-elements/` → `common.hcl`, `accounts.yml`, `terragrunt2.hcl`
  - `my-first-runbook/templates/project/` → `README.md` (all 5 language branches)
- No regressions in `renderFile` unit tests (the existing inline-template path must keep working unchanged).
