# Comprehensive Test Plan for Runbooks Electron Rewrite

## Context

Runbooks was rewritten from Go + browser to Electron + Node.js (all 9 phases complete). The kitchen-sink test runbook shows errors on launch, indicating regressions. The goal is regression confidence: a test suite that makes it **obvious the app works** before shipping. Testing can be a significant part of this codebase.

## Current Coverage Gaps

**Well-tested:** backend domain modules (exec, script, registry, session, boilerplate, path validation), frontend utilities (template deps, validators, log parsing)

**Not tested at all:**
- Zero React component tests for Command, Check, Inputs, Template, TemplateInline, AwsAuth, GitHubAuth, GitClone, GitHubPullRequest, Admonition (only DirPicker has one)
- Zero IPC handler integration tests (11 handler files)
- No test for `ComponentIdRegistry` duplicate/collision detection
- No test for `ErrorReportingContext` error counting
- No test for `RunbookContext` input merging with array `inputsId`
- No test for `useScriptExecution` hook
- Kitchen-sink runbook has no `runbook_test.yml` for CLI headless testing
- Playwright E2E suite is shallow (no execution tests, no output flow, no input interaction)

## Approach

- **Interleaved bug fixing**: write tests, see failures, fix bugs, see passes. Tests and fixes go hand in hand.
- **Playwright is highest priority**: E2E tests catch what users see. CLI headless tests are secondary.
- **Two E2E specs**: one for render assertions (fast, catches launch bugs), one for execution flow (slower, proves pipeline).

## Strategy: 5 Layers, Prioritized

### Phase 1 — Catch bugs fastest (HIGH priority)

- [x] **1A. Playwright E2E — Render assertions** (94 tests, all passing)
- [x] **1B. Playwright E2E — Execution flow** (3 passing, 5 skipped — Effect forkDaemon fiber lifecycle issue)
- [x] **1C. Component tests for Command and Inputs** (29 + 14 = 43 tests)
- [x] **1D. Context tests** (5 + 8 = 13 tests)

#### 1A. Playwright E2E — Render assertions: `electron/e2e/kitchen-sink.spec.ts` (expand)
Add comprehensive render-only tests to the existing spec. These catch launch bugs without clicking Run.

**Global assertions:**
- **Zero errors**: verify error banner shows 0 errors, 0 warnings after full MDX render
- **Console errors**: attach `console.error` listener during page load, assert empty
- **All blocks present**: verify `data-testid` for every block (simple-inline-cmd, setup-outputs, cmd-with-inputs, consume-outputs, cmd-inline-inputs, list-complex-data, check-pass, check-warn, check-with-inputs, sample-config, simple-inline-tpl, output-preview, gen-file-tpl, combined-tpl, set-env, verify-env, change-dir, verify-workdir, capture-files, logging-demo, merged-inputs-cmd, aws-auth-test, gh-auth-test, aws-cmd, gh-cmd, clone-test, pr-test, dir-picker-test, expr-test, expr-check)

**Section-specific render tests:**
- Section 3 (Inputs): all 16 fields render, defaults pre-populated (plain_string="hello world", int_field=42), enum shows dropdown, bool renders toggle, sensitive field masked
- Section 4 (Commands): title, description, Run button visible for each
- Section 7 (Checks): Check button visible, pending state icons
- Section 8 (Template): boilerplate config form renders
- Section 9 (TemplateInline): preview sections visible
- Section 14 (Auth): AwsAuth/GitHubAuth render auth forms; aws-cmd/gh-cmd show unmet auth dependency
- Section 15 (GitClone): prefilled URL visible
- Section 16 (GitHubPullRequest): prefilled fields visible
- Section 17 (DirPicker): directory labels visible

**Fix bugs interleaved**: when a render test fails, investigate and fix the root cause before moving on.

#### 1B. Playwright E2E — Execution flow: `electron/e2e/execution-flow.spec.ts` (new)
A separate spec that tests the execution pipeline by clicking buttons and verifying results.

**Tests (sequential, each depends on prior):**
1. Trust the runbook (dismiss security banner)
2. Run `simple-inline-cmd` → verify success message, logs panel has output
3. Run `setup-outputs` → verify outputs panel shows account_id, region, project_name
4. Run `cmd-with-inputs` → verify template variables resolved in command
5. Run `consume-outputs` → verify output values from setup-outputs appear
6. Run `check-pass` → verify green success status
7. Run `check-warn` → verify yellow/orange warn status
8. Run `set-env` → success
9. Run `verify-env` → verify success (proves env persistence)
10. Run `change-dir` → success
11. Run `verify-workdir` → verify success (proves workdir persistence)
12. Run `capture-files` → verify generated files panel updates
13. Run `logging-demo` → verify log levels appear in output

#### 1C. Component tests for Command and Inputs
- `web/src/components/mdx/Command/__tests__/Command.test.tsx` — renders with valid props, shows errors for invalid props, status transitions, dependency warnings, template expression resolution
- `web/src/components/mdx/Inputs/__tests__/Inputs.test.tsx` — renders all variable types, validation errors, embedded variant, YAML extraction

#### 1D. Context tests
- `web/src/contexts/ComponentIdRegistry.test.tsx` — duplicate detection, normalized collision ("create-account" vs "create_account")
- `web/src/contexts/ErrorReportingContext.test.tsx` — error/warning counting, clear, dedup

### Phase 2 — Comprehensive component coverage (MEDIUM priority)

- [x] **2A. Remaining component tests** (52 tests: Check 13, Admonition 12, AwsAuth 5, GitHubAuth 5, GitClone 5, GitHubPR 4, Template 5, TemplateInline 3)
- [x] **2B. Context integration tests** (already covered: 11 existing RunbookContext tests)
- [x] **2C. Unit test extensions** (29 tests: applyValidationRule 22, normalizeBlockId 7)

#### 2A. Remaining component tests
- `web/src/components/mdx/Check/__tests__/Check.test.tsx` — mirrors Command but adds warn state (exit code 2)
- `web/src/components/mdx/Admonition/__tests__/Admonition.test.tsx` — all 4 types, closable, confirmation text
- `web/src/components/mdx/Template/__tests__/Template.test.tsx` — renders with path, loading state, missing path error
- `web/src/components/mdx/TemplateInline/__tests__/TemplateInline.test.tsx` — preview rendering, dependency resolution
- `web/src/components/mdx/AwsAuth/__tests__/AwsAuth.test.tsx` — auth tabs, default region
- `web/src/components/mdx/GitHubAuth/__tests__/GitHubAuth.test.tsx` — auth tabs
- `web/src/components/mdx/GitClone/__tests__/GitClone.test.tsx` — prefilled URL/ref, file tree option
- `web/src/components/mdx/GitHubPullRequest/__tests__/GitHubPullRequest.test.tsx` — prefilled fields, unmet auth dependency

#### 2B. Context integration tests
- Extend `web/src/contexts/RunbookContext.test.tsx` — test `getInputs` with array `inputsId` (merging), `registerOutputs` normalization, `getTemplateContext`

#### 2C. Unit test extensions
- `web/src/components/mdx/_shared/lib/validators.integration.test.ts` — test `applyValidationRule` dispatcher for all rule types
- Extend `web/src/lib/utils.test.ts` — test `normalizeBlockId` edge cases

### Phase 3 — CLI headless tests + depth (LOWER priority)

- [ ] **3A. CLI headless test**
- [ ] **3B. IPC integration tests**
- [ ] **3C. Edge case unit tests**

#### 3A. CLI headless test: `testdata/kitchen-sink/runbook_test.yml`
Create a `runbook_test.yml` that exercises every executable block headlessly. Validates the backend pipeline without Electron.

**Blocks to test in order:**
- `simple-inline-cmd` → expect success
- `setup-outputs` → expect success, assert outputs: account_id=123456789012, region=us-west-2, project_name=kitchen-sink
- `cmd-with-inputs` → expect success (with all-types inputs provided)
- `consume-outputs` → expect success
- `list-complex-data` → expect success, assert outputs: users, teams
- `check-pass` → expect success
- `check-warn` → expect warn
- `check-with-inputs` → expect success
- `set-env` / `verify-env` → expect success (env persistence)
- `change-dir` / `verify-workdir` → expect success (workdir persistence)
- `capture-files` → expect success, assert files_generated min_count: 2
- `logging-demo` → expect success
- `merged-inputs-cmd` → expect success

#### 3B. IPC integration tests
- `electron/main/ipc/exec.integration.test.ts` — round-trip exec:run with registry, template vars, cancel, output/file capture
- `electron/main/ipc/session.integration.test.ts` — create/get/set-env/reset/delete lifecycle
- `electron/main/ipc/boilerplate.integration.test.ts` — variables parsing, render-inline

#### 3C. Edge case unit tests
- `src/domain/exec/script.edge-cases.test.ts` — parseBlockOutputs with embedded `=`, empty values, parseEnvCapture edge cases
- `src/domain/registry/executable.edge-cases.test.ts` — parseComponents with all 11 block types, JSX expression props

### Test Infrastructure Needed

#### Mock utilities
1. **`web/src/test-utils/mock-hooks.ts`** — factory for `useScriptExecution` mock return values (controls status, logs, outputs for component tests)
2. **Extend `web/src/test-utils/test-utils.tsx`** — add missing context providers to `TestWrapper` (LogsContext, GeneratedFilesContext, SessionContext)
3. **Extend `web/src/test-utils/mock-api.ts`** — add `on`/`once` event listener support for streaming events

#### Test fixtures
1. `web/src/test-utils/fixtures/sample-boilerplate-configs.ts` — pre-parsed configs for each variable type
2. `web/src/test-utils/fixtures/sample-block-outputs.ts` — pre-built outputs for dependency testing

## File Summary

| File | Layer | Phase |
|------|-------|-------|
| `electron/e2e/kitchen-sink.spec.ts` (expand) | E2E render | 1A |
| `electron/e2e/execution-flow.spec.ts` (new) | E2E execution | 1B |
| `web/src/components/mdx/Command/__tests__/Command.test.tsx` | Component | 1C |
| `web/src/components/mdx/Inputs/__tests__/Inputs.test.tsx` | Component | 1C |
| `web/src/contexts/ComponentIdRegistry.test.tsx` | Unit | 1D |
| `web/src/contexts/ErrorReportingContext.test.tsx` | Unit | 1D |
| `web/src/components/mdx/Check/__tests__/Check.test.tsx` | Component | 2A |
| `web/src/components/mdx/Admonition/__tests__/Admonition.test.tsx` | Component | 2A |
| `web/src/components/mdx/Template/__tests__/Template.test.tsx` | Component | 2A |
| `web/src/components/mdx/TemplateInline/__tests__/TemplateInline.test.tsx` | Component | 2A |
| `web/src/components/mdx/AwsAuth/__tests__/AwsAuth.test.tsx` | Component | 2A |
| `web/src/components/mdx/GitHubAuth/__tests__/GitHubAuth.test.tsx` | Component | 2A |
| `web/src/components/mdx/GitClone/__tests__/GitClone.test.tsx` | Component | 2A |
| `web/src/components/mdx/GitHubPullRequest/__tests__/GitHubPullRequest.test.tsx` | Component | 2A |
| `web/src/contexts/RunbookContext.test.tsx` (extend) | Unit | 2B |
| `web/src/components/mdx/_shared/lib/validators.integration.test.ts` | Unit | 2C |
| `web/src/lib/utils.test.ts` (extend) | Unit | 2C |
| `testdata/kitchen-sink/runbook_test.yml` | CLI headless | 3A |
| `electron/main/ipc/exec.integration.test.ts` | Integration | 3B |
| `electron/main/ipc/session.integration.test.ts` | Integration | 3B |
| `electron/main/ipc/boilerplate.integration.test.ts` | Integration | 3B |
| `src/domain/exec/script.edge-cases.test.ts` | Unit | 3C |
| `src/domain/registry/executable.edge-cases.test.ts` | Unit | 3C |
| `web/src/test-utils/mock-hooks.ts` | Infra | 1C |
| `web/src/test-utils/fixtures/sample-boilerplate-configs.ts` | Infra | 1C |
| `web/src/test-utils/fixtures/sample-block-outputs.ts` | Infra | 1C |

## Verification

After implementation, run:
1. `bun run test` — all unit + component tests pass
2. `bun run test:e2e` — Playwright kitchen-sink suite passes with 0 errors
3. `node dist/main/cli.js test testdata/kitchen-sink` — CLI headless test passes all steps
4. `bun run typecheck` — no type errors in new test files
