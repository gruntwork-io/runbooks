# Runbooks rebuild: stack index

The running index of the rebuild stack. Update it whenever the stack changes.

- Spec: "Runbooks rebuild master plan", https://claude.ai/artifact/8YYhibKcx1Q3HZQGypHNE2 (wins on conflicts),
  and "Runbooks block contract proposal", https://claude.ai/artifact/EEiqpN8kjtoekEV2QX6Qrh (JSON Schema sketch, RFC-188 notes).
- Integration branch: `rebuild/main`, cut from `main` at ac543199 (2026-11-24).
- The bottom open PR targets `rebuild/main`; each later PR targets the branch below it.
- Every PR opens as a draft and goes to runbooks-reviewer once its branch is done and green. It is marked ready for review only after that review passes: a draft has not yet passed agent review (the human, 2026-11-26). Only the human merges.
- On 2026-11-25 the human merged #496 to #560 into `rebuild/main`, one commit per PR. The trunk's tree equals the old stack top's (3cd837b5), so open PRs rebase onto it with `git rebase --onto origin/rebuild/main <old base tip>`.
- Later on 2026-11-25 the human merged #565 to #581 the same way: `rebuild/main` 17064004, whose tree equals #581's head (70ff25fe) outside this file. GitHub rebased #582 onto it (7896e7ba). An index commit on `rebuild/main` leaves #582 one commit behind; its diff is unaffected, and its branch was last pushed by GitHub, so it is not force-pushed from here.
- On 2026-11-26 (UTC) the human merged #582 and #585 to #594 the same way: `rebuild/main` d845152e. GitHub rebased #595 onto it (f8229880), so it is not force-pushed from here; this index commit leaves it one commit behind. A rework of a merged PR comes as a new PR on top of the stack (#596 for #594, #597 for #589), never as a push to the merged branch.
- On 2026-11-26 no PR was merged. #598 to #607 went on top of #597, and runbooks-reviewer's finding 6 (test CLI false greens) closed with #601 to #604. #598 is held for decision 9 (Waiting on the human), and #599 and up are stacked on it: if decision 9 goes another way, they rebase onto #597 with `git rebase --onto`.
- Later on 2026-11-26 the human merged #595 to #597 (`rebuild/main` e3e6b8b0), ruled decision 9 (env only) and had #598 closed. Stack #519 had reached GitHub's cap of 100 PRs, merged ones included, so it was unstacked, and #599 to #612 were rebased off #598 onto e3e6b8b0 and linked as stack #614. The human then merged #599 to #611 the same way: `rebuild/main` 242b4e8c. GitHub rebased #612 onto it (50c89a80), so it is not force-pushed from here; this index commit leaves it one commit behind.
- Later on 2026-11-26 the human merged #612 and #615 to #625 the same way (`rebuild/main` c0df6d11). #626's base, #625, was merged while #626 sat in stack #614, and GitHub refuses a base change inside a stack, so #614 was unstacked, #626 rebased onto `rebuild/main`, and #626 and #627 linked as stack **#628**. #629 to #634 followed on top. This index commit leaves #626 one commit behind; its diff is unaffected, and it is not restacked, so the reviewed heads stay as reviewed.
- **Keep it stacked.** The open PRs are GitHub stack #628, based on `rebuild/main` (`gh api repos/gruntwork-io/runbooks/stacks/628`); #519 holds #496 to #598, and #614 holds #599 to #625. `.more9s/stack.sh` keeps it that way:
  - `add <branch> <title> <body-file>` opens each new PR as a draft on the top of the stack, links it into #614, and waits until GitHub lists it on top (two adds in a row once based the second on the PR below the first). Once it is green, send it to runbooks-reviewer, and mark it ready with `gh pr ready` only when the review passes. Don't open a rebuild PR with `gh pr create` alone.
  - `restack` (`--dry-run` first, in a linked worktree) is needed after any commit to `rebuild/main`, such as an index update, or to a lower branch. It rebases each branch onto the one below and force-pushes it with a lease. CI then reruns on every PR above the change, so batch index updates.
  - `check` exits 1 if a PR's base is not the head below it, or if a head lacks commits its base has.

## Finish line

The top of the stack passes, in CI:

- all 37 runbook fixtures, with `baseline/behaviour-changes/*.patch` applied, through the new `runbooks test`;
- all 25 e2e specs, plus the phase 0 files-panel and system specs, against the new app;
- the app's CSP has no `'unsafe-eval'`;
- no block runs against the fake credential provider;
- a toy block added in one folder and two registry lines passes in the app, the CLI and MCP.

## New tree layout

| Path | Package | May import |
|---|---|---|
| `blocks/core/` | block contract | `effect` |
| `packages/core/` | document, parser, engine, protocol, service interfaces, domain | `blocks/core`, `effect` |
| `blocks/<name>/` | one block each | `blocks/core`, `packages/core` |
| `blocks/index.ts`, `blocks/views.ts` | registry, view map | block folders |
| `packages/platform-node/` | layers: the only Node I/O and SDK imports | `packages/core` |
| `packages/app-main/` | Electron main: IPC transport | core, platform-node, `blocks/index.ts` |
| `packages/app-renderer/` | React: walks the document | core (protocol only), `blocks/views.ts` |
| `packages/cli/` | `runbooks` CLI: open, test, validate, mcp | core, platform-node, `blocks/index.ts` |
| `plugin/` | `base.schema.json`, `credential.schema.json` | none |
| `gruntwork-io/runbooks-plugins` | track A Rust sign-in binaries: their own repo, made by the human on 2026-11-24 (empty, public, `main`) | none |
| `baseline/` | frozen baseline list, props, security test names, behaviour-change patches | none |

## Stack

Status: planned, open, green (CI passed on the head), red, merged.
"Green" excludes `Pull Request has non-contributor approval`, which fails on every PR until a human who has not pushed to it approves.

Phase 0 was reordered on 2026-11-24 so dependencies point down the stack: the auth contract owns the credential lifecycle, and the engine protocol carries it.

| # | PR | Phase | Branch | Base | Status | Work products |
|---|---|---|---|---|---|---|
| 1 | #496 | 0 | `rebuild/p0-block-contract` | `rebuild/main` | merged | 0.2 |
| 2 | #497 | 0 | `rebuild/p0-document` | p0-block-contract | merged | 0.4 |
| 3 | #499 | 0 | `rebuild/p0-plugin-transport` | p0-document | merged | 0.5 |
| 4 | #501 | 0 | `rebuild/p0-auth-contract` | p0-plugin-transport | merged | 0.6 |
| 5 | #502 | 0 | `rebuild/p0-engine-protocol` | p0-auth-contract | merged | 0.3 |
| 6 | #503 | 0 | `rebuild/p0-cli-contract` | p0-engine-protocol | merged | 0.7 |
| 7 | #504 | 0 | `rebuild/p0-security-tests` | p0-cli-contract | merged | 0.11 |
| 8 | #505 | 0 | `rebuild/p0-schema-bundle` | p0-security-tests | merged | 0.12 |
| 9 | #507 | 0 | `rebuild/p0-e2e-files-panel` | p0-schema-bundle | merged | 0.9 |
| 10 | #508 | 0 | `rebuild/p0-e2e-system` | p0-e2e-files-panel | merged | 0.10 |
| 11 | #509 | 0 | `rebuild/p0-baseline-list` | p0-e2e-system | merged | 0.8 (the list) |
| 12 | #510 | 0 | `rebuild/p0-behaviour-changes` | p0-baseline-list | merged | 0.8 (the nine changes) |
| 13 | #511 | 1 | `rebuild/p1-packages` | p0-behaviour-changes | merged | 1.1 |
| 14 | #512 | 1 | `rebuild/p1-copy-core` | p1-packages | merged | 1.2 |
| 15 | #513 | 1 | `rebuild/p1-registry` | p1-copy-core | merged | 1.3 |
| 16 | #514 | 1 | `rebuild/p1-block-id` | p1-registry | merged | 1.6 (contract change: `BlockId` normalizes on decode) |
| 17 | #515 | 1 | `rebuild/p1-template-references` | p1-block-id | merged | 1.5 |
| 18 | #516 | 1 | `rebuild/p1-document-contract` | p1-template-references | merged | contract change for 1.4 (guarded edges, `unknownProp`, `notAllowed`) |
| 19 | #517 | 1 | `rebuild/p1-parse` | p1-document-contract | merged | 1.4, part 1: parse, props, ids, errors |
| 20 | #518 | 1 | `rebuild/p1-edge-indices` | p1-parse | merged | contract change for 1.4 (edges by block index; drops the unused `Reference` type) |
| 21 | #521 | 1 | `rebuild/p1-graph` | p1-edge-indices | merged | 1.4, part 2: the reference graph |
| 22 | #522 | 1 | `rebuild/p1-block-errors` | p1-graph | merged | contract change: an error in one block stops that block, not the runbook (`error-scenarios` failed the old contract) |
| 23 | #523 | 1 | `rebuild/p1-files` | p1-block-errors | merged | 1.4, part 3: `loadRunbook`, file hashes, `badFile` |
| 24 | #524 | 1 | `rebuild/p1-edge-source-name` | p1-files | merged | contract change: the template-read edge is tagged `"Output"` (`"Template"` is a block's tag) |
| 25 | #525 | 1 | `rebuild/p1-toy-blocks` | p1-edge-source-name | merged | refactor for 1.7: the core names no block (toy tags, a dead block list) |
| 26 | #526 | 1 | `rebuild/p1-block-lint` | p1-toy-blocks | merged | 1.7; **phase 1's Done when** is in its description |
| 27 | #527 | 2 | `rebuild/p2-refusal-misconfigured` | p1-block-lint | merged | contract change: a misconfigured block's run is refused as `Misconfigured` |
| 28 | #528 | 2 | `rebuild/p2-session` | p2-refusal-misconfigured | merged | 2.1 (sessions, task runs), 2.2 (trust keyed by content hash) |
| 29 | #529 | 2 | `rebuild/p2-plugin-schema-fixes` | p2-session | merged | contract change: plugin schema fixes from the Rust protocol crate |
| 30 | #530 | 2 | `rebuild/p2-field-no-value` | p2-plugin-schema-fixes | merged | contract change: an empty field has no value in the view |
| 31 | #531 | 2 | `rebuild/p2-run-result-submitted` | p2-field-no-value | merged | contract change: a form's submit answers `Submitted` |
| 32 | #532 | 2 | `rebuild/p2-values` | p2-run-result-submitted | merged | 2.1 (form values, submit, review) |
| 33 | #534 | 2 | `rebuild/p2-pretrust-contract` | p2-values | merged | contract change: before-trust functions get no services |
| 34 | #535 | 2 | `rebuild/p2-pretrust` | p2-pretrust-contract | merged | 2.2 (an untrusted session reads the runbook and nothing else) |
| 35 | #536 | 2 | `rebuild/p2-fs-roots-contract` | p2-pretrust | merged | contract change: named roots, open by absolute path |
| 36 | #537 | 2 | `rebuild/p2-fs-roots` | p2-fs-roots-contract | merged | 2.3 |
| 37 | #538 | 2 | `rebuild/p2-env-contract` | p2-fs-roots | merged | contract change: one exit-code table, `envNames` |
| 38 | #539 | 2 | `rebuild/p2-env` | p2-env-contract | merged | 2.4 |
| 39 | #540 | 2 | `rebuild/p2-exit-codes` | p2-env | merged | 2.5 |
| 40 | #541 | 2 | `rebuild/p2-env-event` | p2-exit-codes | merged | contract change: env only through `$RUNBOOK_ENV` |
| 41 | #542 | 2 | `rebuild/p2-run-scope` | p2-env-event | merged | fix: a run's scope ends with the run |
| 42 | #543 | 2 | `rebuild/p2-auth-contract` | p2-run-scope | merged | contract change for 2.6 |
| 43 | #544 | 2 | `rebuild/p2-auth` | p2-auth-contract | merged | 2.6 (detect after trust, credential store, run variables) |
| 44 | #545 | 2 | `rebuild/p2-auth-act` | p2-auth | merged | 2.6 (`ActOnCredential`, sign-out) |
| 45 | #546 | 2 | `rebuild/p2-auth-expiry` | p2-auth-act | merged | 2.6 (expiry, refresh) |
| 46 | #547 | 2 | `rebuild/p2-provider-fit` | p2-auth-expiry | merged | contract change: seven fits the three sign-in binaries found |
| 47 | #548 | 2 | `rebuild/p2-settings-contract` | p2-provider-fit | merged | contract change for 2.7 |
| 48 | #549 | 2 | `rebuild/p2-settings-store` | p2-settings-contract | merged | 2.7 |
| 49 | #550 | 2 | `rebuild/p2-settings-providers` | p2-settings-store | merged | 2.7 (providers get the CA bundle and proxy) |
| 50 | #551 | 2 | `rebuild/p2-settings-import` | p2-settings-providers | merged | 2.7 (first-start import of today's settings files) |
| 51 | #555 | 2 | `rebuild/p2-sessions-contract` | p2-settings-import | merged | contract change for 2.8 |
| 52 | #556 | 2 | `rebuild/p2-sessions-store` | p2-sessions-contract | merged | 2.8 (SQLite database, cipher) |
| 53 | #557 | 2 | `rebuild/p2-sessions-saved` | p2-sessions-store | merged | 2.8 (payload, version, run-log cap) |
| 54 | #558 | 2 | `rebuild/p2-sessions-resume` | p2-sessions-saved | merged | 2.8 (resume) |
| 55 | #559 | 2 | `rebuild/p2-sessions-credentials` | p2-sessions-resume | merged | 2.8 (credential resume) |
| 56 | #560 | 2 | `rebuild/p2-sessions-retention` | p2-sessions-credentials | merged | 2.8 (retention) |
| 57 | #565 | 2 | `rebuild/p2-transport-contract` | `rebuild/main` | merged | contract change for 2.9: `Engine.resolveApproval`; a settings watch ends with the store |
| 58 | #566 | 2 | `rebuild/p2-transport` | p2-transport-contract | merged | 2.9 |
| 59 | #568 | 2 | `rebuild/p2-cli-validate` | p2-transport | merged | 2.10 (`runbooks validate`, the entry point); contract change: `CliFailure` Unreadable, TooManyFiles; knip covers the packages |
| 60 | #569 | 2 | `rebuild/p2-test-schema` | p2-cli-validate | merged | 2.11 |
| 61 | #570 | 2 | `rebuild/p2-cli-test` | p2-test-schema | merged | 2.10 (`runbooks test`); contract change: `CliFailure` Cancelled |
| 62 | #571 | 2 | `rebuild/p2-plugin-contract` | p2-cli-test | merged | contract change for 2.12 (`transport.ts`: `open` sends `configure`, per-method timeout) |
| 63 | #572 | 2 | `rebuild/p2-plugin-owner` | p2-plugin-contract | merged | 2.12 (the owner, a stub binary) |
| 64 | #573 | 2 | `rebuild/p2-plugin-lint` | p2-plugin-owner | merged | 2.12 (the lint) |
| 65 | #574 | 2 | `rebuild/p2-plugin-grace` | p2-plugin-lint | merged | contract change for 2.13: `exitGraceMillis` 5 s; `base.schema.json` `callTimeoutsMillis` |
| 66 | #575 | 2 | `rebuild/p2-credential-contract` | p2-plugin-grace | merged | contract change for 2.13: `credential.schema.json` `envValue.file` |
| 67 | #576 | 2 | `rebuild/p2-credential-host` | p2-credential-contract | merged | 2.13 (a provider's environment, owner-only state folders) |
| 68 | #577 | 2 | `rebuild/p2-plugin-memory` | p2-credential-host | merged | 2.13 (`PluginProcess` in memory) |
| 69 | #578 | 2 | `rebuild/p2-credential-client` | p2-plugin-memory | merged | 2.13 (the credential client) |
| 70 | #579 | 2 | `rebuild/p2-credential-fake` | p2-credential-client | merged | 2.13 (the fake) |
| 71 | #580 | 2 | `rebuild/p2-credential-suite` | p2-credential-fake | merged | 2.13 (the contract suite) |
| 72 | #581 | 2 | `rebuild/p2-credential-names` | p2-credential-suite | merged | 2.13 follow-up (`envConflict`; provider names within the block's) |
| 73 | #582 | 2 | `rebuild/p2-plugin-eof` | `rebuild/main` | merged | contract change: `base.schema.json`, a call in flight at end of input may get no answer |
| 74 | #585 | 2 | `rebuild/p2-main-sync` | p2-plugin-eof | merged | merge `main` at d7136710; baseline refresh (38 fixtures, 22 tags) |
| 75 | #586 | 2 | `rebuild/p2-main-port` | p2-main-sync | merged | port main's git and GitLab service changes into `packages/` |
| 76 | #587 | 2 | `rebuild/p2-task-reads` | p2-main-port | merged | contract change: `TaskReads`, a task reads its files and the outputs its templates name |
| 77 | #588 | 2 | `rebuild/p2-script-values` | p2-task-reads | merged; review asked for changes (row 87) | decision 9: `{{ }}` values inserted as quoted variable expansions |
| 78 | #589 | 2 | `rebuild/p2-command` | p2-script-values | merged; review asked for changes (#597) | Command in the registry; phase 2's Done when |
| 79 | #590 | 2 | `rebuild/p2-fix-id-words` | p2-command | merged | contract change: a block id is letters, digits, `-` and `_` |
| 80 | #591 | 2 | `rebuild/p2-fix-state-dir` | p2-fix-id-words | merged | two ids that differ only in case get two state folders |
| 81 | #592 | 2 | `rebuild/p2-fix-shared-refs` | p2-fix-state-dir | merged | contract change: `inputsId`, `dependsOn`, `envFrom` take one id or a list |
| 82 | #593 | 2 | `rebuild/p2-fix-yaml-aliases` | p2-fix-shared-refs | merged | YAML whose alias holds itself is an error at the alias |
| 83 | #594 | 2 | `rebuild/p2-fix-spawner-bounds` | p2-fix-yaml-aliases | merged; review asked for changes (#596) | the spawner's memory is bounded; a signal exits 128+n |
| 84 | #595 | 2 | `rebuild/p2-fix-trust-hash` | `rebuild/main` | merged | a folder's trust hash covers each byte and executable bit; size and count limits on named files |
| 85 | #596 | 2 | `rebuild/p2-fix-whole-lines` | p2-fix-trust-hash | merged | #594's rework: a long line's pieces are marked and joined for parsers; the spawner pauses only while read |
| 86 | #597 | 2 | `rebuild/p2-command-rework` | p2-fix-whole-lines | merged | #589's rework: an exit test that can fail, recorded calls, no Node in `block.ts` |
| 87 | #598 | 2 | `rebuild/p2-values-rework` | p2-command-rework | closed: the human ruled decision 9 env only | #588's rework: `{{ }}` lexer bypasses, evaluating positions, NUL and size limits, every problem reported |
| 88 | #599 | 2 | `rebuild/p2-command-inputs` | `rebuild/main` | merged | #589 finding 3: a nested `<Inputs>` in a task, read last |
| 89 | #600 | 2 | `rebuild/p2-e2e-spec-list` | p2-command-inputs | merged | the baseline's e2e list equals the specs on disk |
| 90 | #601 | 2 | `rebuild/p2-fix-test-regex` | p2-e2e-spec-list | merged | review finding 6: `runbooks test` reads regexes as today's CLI does |
| 91 | #602 | 2 | `rebuild/p2-run-files-contract` | p2-fix-test-regex | merged | contract change: `BlockView.files` and `filesTruncated` |
| 92 | #603 | 2 | `rebuild/p2-run-generated-files` | p2-run-files-contract | merged | `$GENERATED_FILES` and `$REPO_FILES`; the copy on a good end |
| 93 | #604 | 2 | `rebuild/p2-fix-files-generated` | p2-run-generated-files | merged | review finding 6: `files_generated` counts the named block's files |
| 94 | #605 | 2 | `rebuild/p2-command-repository` | p2-fix-files-generated | merged | Command's `repository` prop, so a Command gets `$REPO_FILES` |
| 95 | #606 | 2 | `rebuild/p2-command-docs-landed` | p2-command-repository | merged | #589 finding 5: Command's `docs.mdx` |
| 96 | #607 | 2 | `rebuild/p2-e2e-test-match` | p2-command-docs-landed | merged | #600 follow-up: each Playwright config runs only `*.spec.ts` |
| 96a | #608 | 2 | `rebuild/p2-fix-status-memo` | p2-e2e-test-match | merged | review: a block's status is decided once per pass |
| 96b | #609 | 2 | `rebuild/p2-fix-credential-restart` | p2-fix-status-memo | merged | review: a block whose provider lost its login finds it again or signs out |
| 96c | #610 | 2 | `rebuild/p2-fix-secret-scan` | p2-fix-credential-restart | merged | contract change: a `values` detection source says which values are secret |
| 96d | #611 | 2 | `rebuild/p2-fix-secret-scan-client` | p2-fix-secret-scan | merged | review: the credential client scans each string, and knows detect's secrets |
| 96e | #612 | 2 | `rebuild/p2-fix-interrupts` | `rebuild/main` | merged | review group 8 items 1 and 2: a run's start and a session's close, once begun, end |
| 96f | #615 | 2 | `rebuild/p2-fix-concurrent-open` | p2-fix-interrupts | merged | review group 8 item 3: two opens at once resume a saved session once |
| 96g | #616 | 2 | `rebuild/p2-events-unknown-sequence` | p2-fix-concurrent-open | merged | contract change: `Events` refuses an `after` the session has not logged (`UnknownSequence`) |
| 96h | #617 | 2 | `rebuild/p2-resume-sequence` | p2-events-unknown-sequence | merged | review group 8: a resumed session goes on past every sequence the one it resumes reserved |
| 96i | #618 | 2 | `rebuild/p2-events-docs` | `rebuild/main` | merged | runbooks-reviewer's notes on #616/#617: where a resumed or trimmed log starts; `LIMITS.keptEvents` |
| 96j | #619 | 2 | `rebuild/p2-settings-import-once` | p2-events-docs | merged | review group 11: today's settings are imported once (`settings.imported`) |
| 96k | #620 | 2 | `rebuild/p2-sessions-db-open` | p2-settings-import-once | merged | review group 11: the sessions database waits for another's lock, and migrates in one transaction |
| 96l | #621 | 2 | `rebuild/p2-env-templates` | p2-sessions-db-open | merged | decision 9: `env` values fill in `{{ }}`, and take numbers and booleans again |
| 96m | #622 | 2 | `rebuild/p2-script-contract` | `rebuild/main` | merged | contract change: `TaskBlock.scripts` (`ScriptSource`) |
| 96n | #623 | 2 | `rebuild/p2-script-template-error` | p2-script-contract | merged | decision 9 and the no-checks ruling: a script runs as written and makes no edges; migrations to `env`; Command docs |
| 96o | #624 | 2 | `rebuild/p2-sessions-db-damaged` | p2-script-template-error | merged | review group 11: a damaged sessions database (`quick_check`) is left as it is |
| 96p | #625 | 2 | `rebuild/p2-settings-temp-name` | p2-sessions-db-damaged | merged | review group 11: each settings write has its own temporary file |
| 96q | #626 | 2 | `rebuild/p2-review-smalls` | `rebuild/main` | ready (reviewer passed) | runbooks-reviewer's notes on #621, #623 and #625: the `{{ "{{" }}` hint, `Object.hasOwn`, a refused task's props not read, `replaceWith`'s own error |
| 96r | #627 | 2 | `rebuild/p2-cli-contract` | p2-review-smalls | ready (reviewer passed) | review group 12: `validate` reads `RUNBOOKS_OUTPUT=junit` as text; a test file that can't be loaded fails its runbook's `config` test |
| 96s | #629 | 2 | `rebuild/p2-task-time-limit` | p2-cli-contract | ready (reviewer passed) | contract change: `TaskBlock.timeLimit`, kept by the engine |
| 96t | #630 | 2 | `rebuild/p2-test-ignores-timeouts` | p2-task-time-limit | ready (reviewer passed) | review group 12: `runbooks test` ignores a block's own time limit, as today (`blockTimeLimits`) |
| 96u | #631 | 2 | `rebuild/p2-load-flakes` | p2-test-ignores-timeouts | draft | three tests that failed with other suites running (#620's second writer, #608's one-pass ratio, the CLI tests' case-folder check), and #608's Blocked note |
| 96v | #632 | 2 | `rebuild/p2-core-environment` | p2-load-flakes | draft | review group 9: the core reads the app's environment only through `Environment` |
| 96w | #633 | 2 | `rebuild/p2-lint-gaps` | p2-core-environment | draft | review group 9: the lint gaps, and a test of each `block.ts`'s import graph |
| 96x | #634 | 2 | `rebuild/p2-walk-bound` | p2-lint-gaps | draft | review group 9: a walk holds at most 256 entries for its reader |
| 97 | none | 2 | the rest of the `rebuild/main` review's fixes | p2-walk-bound | planned | see Follow-ups owed |
| 98 | none | A | `rebuild/pA-plugins-lock` | row 97 | planned (built) | A.5 (`resources/plugins.lock`, its loader) |
| 99 | none | A | `rebuild/pA-plugins-recipes` | pA-plugins-lock | planned (built) | A.5 (fetch, check and bump recipes) |
| 100 | none | A | `rebuild/pA-plugins-packaging` | pA-plugins-recipes | planned (built) | A.6 (CI and release check the bundled binaries; `mac.signIgnore`) |

On 2026-11-24 the human found the PRs were not properly stacked:
- #496 lacked four index commits on `rebuild/main`. Every branch was rebased; trees were unchanged apart from this file.
- The PRs were not linked as a GitHub stack. They now are, with `gh stack link --base rebuild/main 496 … 518` (gh-stack v0.2.0), which created stack #519.

Phase 1 ended with #526 on 2026-11-24. Phase 2's work products ended with #581 (merged 2026-11-25); #582 is a contract addendum. Command landing in phase 2 is my choice: the Done when needs a Command fixture in the test CLI, and the registry is empty until it lands. #589 carries phase 2's Done when, and #597 replaces its exit test with one that can fail. runbooks-reviewer's review of `rebuild/main` at 17064004 asked for changes, so the phase 2 fix PRs (from #590) come before track A. Rows 87 to 96 are that queue so far, in the order the reviewer's findings and the docs subagent's report asked for them. Track A's two lock PRs and its packaging PR then open before phase 3, because phase 3's entry points read the lock to start real binaries; they also wait for a plugins release that speaks protocol "2".

## Track A: gruntwork-io/runbooks-plugins

The Rust sign-in binaries, on the gruntwork-io-team/rust-base template, as GitHub stack #9 in that repo. **Since 2026-11-25 a separate `runbooks-plugins` Claude session owns it** (the human's instruction): send it plugin work, contract changes and CI findings; don't push there from this session.

- Stack #9 (#7, #8, #10 to #28) was merged by the human on 2026-11-25 (19:40 to 19:49 UTC); main bece31c. The unpushed branches `track-a/schema-resume`, `resume-from-values` and `google-tls-error` were handed to that session.
- `schema/credential.schema.json` there must stay byte-identical to `plugin/credential.schema.json` here. A contract change here is sent to that session with its PR number.
- v0.1.0 was published on 2026-11-25 (tag v0.1.0, a423b78): 12 binaries for darwin arm64 and amd64, linux amd64 and windows amd64, plus `SHA256SUMS`; assets are `<bin>_<ver>_<os>_<arch>[.exe]`. No linux arm64 (the human's call; the lock leaves it out, so the owner answers `notInstalled`). A.5 and A.6 are built on `rebuild/pA-plugins-*` (rows 75 to 77).
- Contract changes since the handover, sent to that session with their hashes: #574 (`callTimeoutsMillis`), #575 (`envValue.file`), #582 (no answer at end of input). v0.1.0 ignores `callTimeoutsMillis` but fails `env` without `file`, so the lock moves to the next release before any block uses a real binary.
- A.6 (the hash check): the owner checks the pinned hash before every start (#572). electron-builder would re-sign bundled Mach-O binaries and change their bytes, so `mac.signIgnore` leaves the plugin binaries as their release signed them; proven on a local ad hoc package (byte-equal, Developer ID kept), unproven with real signing and notarization until a release run.
- Since 2026-11-26 that session copies the schemas from `rebuild/main` (at d845152e: `base.schema.json` ce6348b7, `credential.schema.json` 846beb2a). Its open PRs: #36 (Azure `error_line` past a wrapper's first line, for #520) and #37 to #39 (resume from saved values, Google TLS errors).
- **The plugin protocol stays at version "1"** (the human, 2026-11-26: "we should not uptick the protocol to 2, no one uses it yet. Let's start at 1. Keep the variable value for the protocol version though"). `PROTOCOL_VERSION` stays in `packages/core/src/plugin/transport.ts` as "1"; runbooks-plugins dropped its held bump, so 0.2.0 (its #49) speaks "1". Row 98 pins 0.2.0, with a CI check that `plugin/*.schema.json` are byte-equal to the release's schema assets.
- Crates approved by the human: serde, serde_json, thiserror, tokio, reqwest (rustls), time, typify, jsonschema and tempfile (dev), aws-config, aws-sdk-sts/sso/ssooidc/iam/account, aws-runtime, aws-types, aws-smithy-http-client, rustls, base64, subtle, libc, windows-sys. Any other direct crate is ask-first; transitive ones are vetted in the PR body.

## Work products

| WP | Item | PR | State |
|---|---|---|---|
| 0.1 | Rulings on the 18 open decisions | none | not done: the human's to make. Each PR built on a recommendation names it under Decisions. |
| 0.2 | `blocks/core/contract.ts` | #496 | merged |
| 0.3 | Engine protocol | #502 | merged |
| 0.4 | Document type | #497 | merged |
| 0.5 | `plugin/base.schema.json` | #499 | merged |
| 0.6 | `plugin/credential.schema.json` | #501 | merged |
| 0.7 | CLI contract | #503 | merged |
| 0.8 | Frozen baseline list, nine changes applied | #509, #510 | merged |
| 0.9 | Files panel e2e spec | #507 | merged |
| 0.10 | System integration e2e spec | #508 | merged |
| 0.11 | Security regression tests by name | #504 | merged |
| 0.12 | Renderer bundle carries Effect Schema | #505 | merged |
| 0.13 | Throwaway prototype | none | not done: phases 2 and 3 build the same path for real (#510 Gaps) |
| 1.1 | Workspace packages with declared exports | #511 | merged; `app-main`, `app-renderer` and `blocks` get their tsconfig when they get code |
| 1.2 | Services, layers, shared domain code copied | #512 | merged |
| 1.3 | Registry and typed view map | #513 | merged |
| 1.4 | `parseRunbook` | #516, #517, #518, #521, #522, #523 | merged |
| 1.5 | The one template-reference extractor | #515 | merged |
| 1.6 | The one id comparison | #514 | merged |
| 1.7 | Lint rules for blocks | #526 (#524, #525 make the tree pass) | merged |
| 2.1 | The session: block states, values, the event log | #528, #532 | merged |
| 2.2 | Trust keyed by content hash; pre-trust marking | #528, #534, #535 | merged |
| 2.3 | Filesystem roots set by the engine | #536, #537 | merged |
| 2.4 | The per-run environment builder | #538, #539 | merged |
| 2.5 | `$RUNBOOK_ENV` and the single exit-code table | #540, #541, #542 | merged |
| 2.6 | The auth lifecycle and the credential store | #543 to #547 | merged |
| 2.7 | The settings store | #548 to #551 | merged |
| 2.8 | The session store | #555 to #560 | merged |
| 2.9 | The in-process transport | #565, #566 | merged |
| 2.10 | `runbooks test` and `runbooks validate` | #568, #570 | merged |
| 2.11 | The `runbook_test.yml` schema | #569 | merged |
| 2.12 | The plugin transport owner, tests against a stub binary | #571, #572, #573 | merged |
| 2.13 | The credential client, the fake provider, the contract suite | #574 to #581 (#582 a contract addendum) | merged |
| A.1 | The binaries' repo, with its build, signing and release | runbooks-plugins | done (that session) |
| A.2 | The AWS binary | runbooks-plugins | released v0.1.0 |
| A.3 | The Google binary | runbooks-plugins | released v0.1.0 |
| A.4 | The Azure binary, wrapping `az` | runbooks-plugins | released v0.1.0 |
| A.5 | `resources/plugins.lock`, the fetch recipe and the bump recipe | rows 98, 99 | built, opens after the phase 2 fixes and the plugins 0.2.0 release |
| A.6 | The hash check before a binary starts | #572; row 100 for the packaged bytes | merged; row 100 built |

## Open decisions built on

Each row names the PR whose description carries the Decisions entry.

| # | Built on (the plan's recommendation) | First PR |
|---|---|---|
| 1 | A headless engine in the core | #496 |
| 2 | Four classes plus five capabilities | #496 |
| 8 | Command and Check outputs declared through an `outputs` prop | #496 |
| 10 | A top-level `blocks/` folder | #496 |
| 11 | A `repository` prop; `gitAuthId` kept | #496 |
| 7 | No click when pins match; confirm when the block pins nothing (`confirmsDetected`) | #501 |
| 12 | MCP baseline is the in-app server's ten tools (`BASELINE_MCP_TOOLS`) | #502 |
| 18 | More than one window left out; the protocol is session-scoped | #502 |
| 13 | CLI named `runbooks`, `runbooks-test` kept as an alias | #503 |
| 3 | Baseline is today's behaviour with the nine ruled changes applied | #509 |
| 5 | `*AuthId` aliases kept with a warning, no removal date; fixtures keep them | #510 |
| 17 | Finish needs a clean success; gh and az still read their own config | #510 |
| 9 | Ruled by the human (2026-11-26): env only, and then no `{{ }}` checks in scripts ("we only have a few runbooks in public and we manage them. We can retire the old logic entirely and rely on env vars"). A script runs as written: Runbooks neither fills in nor checks a `{{ }}` in it, and a script makes no edges. A value reaches a script only through `env`, whose values are templates | #588 built the old recommendation; #598 closed; #621 to #623 build the ruling |
| 15 | Windows left as it is: environment names compare case-sensitively | #539 |
| 6 | Saved sessions keep form values and credentials, drop run history from older versions | #544 |
| 16 | One repo, one version for all binaries, hashes checked against the release's `SHA256SUMS` | row 98 (unopened) |

Choices of my own that need a ruling (not among the 18):

| Choice | PR |
|---|---|
| An expired credential withdraws its env (today it stays published while shown as failed) | #501 |
| `act_on_block` actions with no generic command (GitClone `use_local_checkout`, GitPullRequest `push`/`delete_branch_and_retry`, Iframe, Chapter, Admonition) settled per block in phase 4 | #502 |
| The baseline gate also runs the two step 0 e2e specs (27, not the plan's 25) | #509 |
| `$RUNBOOK_ENV` takes multiline values as `NAME<<DELIMITER` (the plan says only `KEY=VALUE`) | #510 |
| `$RUNBOOK_ENV` may set `PATH`; a block takes it only by naming the writer in `envFrom` | #510 |
| A block whose `envFrom` source has not run is Blocked, as for `dependsOn` | #510 |
| Every block that reads or writes a repository names it, not only pull request blocks on two-repository pages | #510 |
| Packages are TypeScript projects with `paths` exports and references, not Bun workspaces (a workspace link makes any import resolve) | #511 |
| `blocks/core` is its own package, `blocks-core`, so `core` can import the contract without a cycle | #511 |
| A domain test that runs against a real layer moves to `platform-node/src/integration/` | #512 |
| The registry is a module of re-exports keyed by tag; `registryProblems` checks name = tag | #513 |
| Only display blocks must have a view; the other classes fall back to their class's view | #513 |
| A view also gets its rendered markdown `children` | #513 |
| The id comparison lives in the `BlockId` schema, so ids compare with `===` | #514 |
| The extractor returns every occurrence; `outputsRead` merges | #515 |
| An unknown prop is a warning, not an error (four baseline fixtures use one) | #516 |
| Shared props apply by class and effects, not per block | #517 |
| `*AuthId` aliases are `envFrom` sources after `envFrom`'s own; code in `parse.ts` (decision 5) | #517 |
| Form values are live before submit, and a person's change un-reviews an agent's value (both differ from today) | #532 |
| A malformed `$RUNBOOK_OUTPUT`/`$RUNBOOK_ENV` line fails the run (today it is skipped) | #540 |
| The in-process transport serves one server per client with its origin fixed at creation, and caps no calls in flight | #566 |
| Command's definition lands in phase 2 so phase 2's Done when holds as written; phase 3 adds its view | planned |
| `runbooks test` refuses before running anything when a test file is invalid; `error_contains` needs `config_error`, `missing_outputs` needs `blocked` | #569, #570 |
| Transport errors end a plugin's session; a remote error ends only its call; a call given up ends the session (closing standard input is the only cancel) | #571 |
| The owner kills the plugin's POSIX process group after the grace; on Windows only the plugin | #572 |
| A request line past the cap fails only that call; no cap on calls in flight; errors never quote a plugin's output | #572 |
| The plugin-binary lint is lexical (a string holding `runbooks-<kind>-`) and covers the packages; blocks cannot import `child_process` at all | #573 |
| Per-method limits, sent in `configure`: configure 30 s; detect, targets, select, env 120 s; signOut 60 s; signIn 15 min. The engine waits each plus configure plus 10 s | #574 |
| A credential plugin runs with the base environment plus its own block's `envNames` from the process environment | #576 |
| The engine makes each block's state folder 0700 and refuses one others can read | #576 |
| The fake works at the wire level (`PluginHandler`), in memory and as a process, so engine tests run the real client | #579 |
| The client looks for secrets it knows (8 characters or more, the last 256) in identities, targets, prompts and errors; a prompt holding one ends the sign-in | #578 |
| A plugin started again must describe the same levels, names and requirements | #578 |
| A provider name outside its block's `envNames` and outputs makes the block unavailable; `envConflict` warns once per pair of blocks | #581 |
| A call in flight when standard input closes gets no answer (with runbooks-plugins) | #582 |
| Track A's lock PRs open before phase 3, which reads the lock | row 98 |
| The lock is `{ plugins: PluginEntry[] }`; fetch is all or nothing and removes unpinned plugin binaries; bump takes the plugins from `SHA256SUMS` (only `<bin>_<ver>_<os>_<arch>[.exe]` entries: since plugins #46 it also lists `*.schema.json`, which the schema byte check reads), cross-checked both ways with the API's digests | rows 90, 91 |
| Plugin settings: AWS `defaultRegion`; Google `defaultRegion`, `defaultZone`; Azure none. No settings declaration in the contract (with runbooks-plugins: a refusal names the valid ones) | phase 3 |
| After a restart an AWS SSO or role login comes back as plain keys that cannot refresh: carrying the SSO token needs a secret at rest in `stateDir` (not built) | runbooks-plugins resume follow-up |
| runbooks-plugins keeps rust-base's `unsafe_code = "forbid"`: Azure's process tree uses std plus `/bin/kill` and `taskkill.exe`, not the approved libc/windows-sys FFI; Windows ACLs on `stateDir` wait on the same ruling | runbooks-plugins #24 |
| An unknown block is one error per use; a regex prop value is `badProp` | #517 |
| Edges name blocks by index | #518 |
| `githubAuthId` on a block with its own git-credential prop (GitClone, GitHubPullRequest) is that prop's alias, not an `envFrom` source | #517 |
| A cycle is one error per set of blocks that wait for each other, at its first block, naming the shortest loop | #521 |
| `syntax`, `notAllowed`, `unknownBlock`, `versionRequired` refuse the runbook; every other error stops its block (`Misconfigured`), and the second of two blocks with one id is the misconfigured one | #522 |
| Parsing takes two steps so the loader reads only the files blocks name; a missing or outside file is `badFile` at its prop; a folder hashes as `hashTemplateDir` | #523 |
| The block-name lint counts the baseline's 21 blocks before they land, counts code (a string equal to a tag or holding `<Tag`, a key, element or export) and not comments or imported names, and covers the packages only | #526 |
| A `views.ts` entry is one line naming its folder | #526 |
| Command lands in phase 2, so its PR carries phase 2's Done when | #589 |
| The baseline keeps `ShowWhen` as a display stand-in | #585 |
| A child killed by a signal exits 128 plus the signal's number; past 8M unread characters the child's pipes pause | #594, #596 |
| A line over 64K characters comes in marked pieces; parsers read whole lines through `wholeLines`; a caller that never reads keeps every line | #596 |
| A file a block names is capped at 1 MiB, a folder at 8 MiB, 2000 entries and 16 levels; file and folder hashes are tagged apart | #595 |
| `block.ts` may import no Node built-in, pure ones included | #597 |
| Command keeps no per-run log file; a declared output never written fails its consumer; an inline command's template error says "The command, line N" | #597 |
| The Azure plugin fails `detect` when `az account list --refresh` fails (today warns and goes on) | runbooks-plugins, for #520 |

## Waiting on the human

| What | Options | Where it shows |
|---|---|---|
| GitClone declares `push` for an empty remote, and a block that declares `push` may only `expect: skip`, but file-workspace, git-clone and inputs-and-outputs expect GitClone to succeed | GitClone declares its push apart from its clone (recommended), or the three steps skip (a tenth behaviour change) | `baseline/testFiles.test.ts` pins the three (#569) |
| `ShowWhen` is kept in the baseline as a display stand-in (#585) | keep it, or drop it from the baseline | the baseline list |
| The Azure plugin fails `detect` when its refresh fails (#520); today warns and goes on | keep failing (built), or warn and go on | runbooks-plugins |
| The master plan's line 218 shows `instruction(TaskInput)`; #587 made it `TaskReads` | update the plan | the master plan |
| A linux arm64 plugin binary | build it (runbooks-plugins has a branch) or leave Linux on ARM `notInstalled` | `resources/plugins.lock` |
| A no-proxy list | a setting plus a contract change, or none | the credential contract |
| A link inside a folder a block names is refused (#595 Decision 1); `docs/intro/files_workspace.mdx:125-131` documents following links that stay in the folder | refuse (built), or follow a link whose real path is inside the runbook's folder | #595 |
| The 2000-entry cap on a named folder now counts folders as well as files (#595 Decision 2) | keep, or count files only | #595 |
| A block id is ASCII letters, digits, `-` and `_` (#590); authors see it as a parse error | keep, or widen the pattern | #590 |
| The credential contract's six `[account]` cases need real AWS, GCP and Azure accounts, and the Azure waiting case needs `az` installed where it runs | provide test accounts (and `az`) for a run, or leave those cases unrun | the track-A lock PR's Gaps (row 98) |

## Failed attempts

| Check | Attempt | Result |
|---|---|---|
| #573's unit tests in CI | Read the message of a plugin that fails to load from oxlint's output | GitHub's runners default oxlint to its github format, which drops that message; the test asks for `-f default` (907fda47). |
| Generate TS from `plugin/base.schema.json` | `not: { required: [id] }` on notifications | Effect's importer: "Cannot import JSON Schema keyword \"not\"". Rule moved to the transport owner (#499). |
| Decision 9 in CI and review | List the places bash evaluates a word by lexing the script (#588), then patch the misses (#598) | Review rounds 1 and 2 each found classes that still ran a value. The premise, not the patch, failed; the human ruled env only (2026-11-26). |

## Follow-ups owed

| What | Where it lands |
|---|---|
| `app-renderer` may import only the protocol from core: no rule enforces it yet | phase 3, when the package gets code |
| `src/` and its copies in `packages/` drift until the old tree goes | phase 6 |
| GitGuardian incidents 27121678, 33923057, 33923058 re-raised by the copy | the human, in the GitGuardian dashboard |
| Decision 8 (declared outputs): 21 template reads in 9 testdata runbooks use a Command output no `outputs` prop declares, so they fail to load. They need `outputs` patches. | phase 3, with Command (Check in phase 4) |
| The MDXContainer security tests' rendering half (the page shows literal props) | phase 3, with the tree walker |
| `rebuild/main` holds `main` to d7136710 (#585, #586); a later sync repeats the merge and the port command in #586's Evidence | before phase 6 |
| A block's errors show in place of its view (#522) | phase 3, the renderer |
| `showWhenBlock`'s target check becomes a `run`-capability reference on Command, Check and Finish (#525 removed the old type list) | phases 3 and 4 |
| `<Iframe>` passes the literal-only check: a test in the Iframe block's folder (#525 moved the core's case to `<Script>`) | phase 4, Iframe |
| The block-name lint reads `baseline/props.json`; when the baseline retires, the registry alone names the blocks (#526) | phase 6 |
| `TaskInput.values` hands sensitive form values in clear: make them `Redacted` entries or a secrets map | phase 3, before the phase 4 fan-out |
| `BlockView` and `SessionView` carry node errors (parse and engine-found); `FieldView` needs `section` and `optionLabels` | phase 3 |
| Where a form block's output values come from (the engine uses the same-name field, wrong for DirPicker and Iframe) | phase 3 |
| A block waits for each input its template references (today, #489); a referenced optional field with no default runs with an empty string | phase 3, Command |
| A run gets the hashed script texts instead of re-reading them; `instruction()` input needs an I/O-free build | phase 3, Command (contract change) |
| A plugin-backed form needs a read after trust (Layer 3 against the trust rule) | phase 4 (contract change) |
| A person-picked checkout root, and Template targets in it | phase 4 |
| `NodeSessionDatabase` is first wired by the app's entry point; the test CLI keeps no saved sessions (#570) | phase 3 |
| `SetValues` payload (keys, value size) uncapped; a malformed payload from an untyped caller is untested | phase 3, MCP (the first untyped caller) |
| A `LogLines` event holds up to 10,000 lines and no line length is capped; the transport's stream buffer counts events | phase 3, with the IPC transport |
| The base environment's `PATH` is not refreshed; the heredoc advice in the docs (plan item 615) | phase 5 |
| `baseline/security-tests.ts`: two tests renamed in phase 2 | phase 6 |
| No no-proxy list in the credential contract; the plugins take only `configure`'s `proxy` and ignore the environment's proxy variables by design (`az` inherits what the plugin passes) | the human, then a contract change |
| The test CLI hands `inputs` values to `SetValues` cast `as never`: decode them to the protocol's value type | phase 3 |
| A `runbook_test.yml` file assertion accepts an absolute or `..` path (read only, contains only, 1 MiB cap) | phase 3 |
| The WASM renderer, the new CLI's release packaging and the `runbooks-test` alias binary are not wired; SIGINT handling is untested | phases 5 and 6 |
| Windows: no process-tree kill for plugins (a job object or `taskkill /T`), no ACL check on state folders, no Windows CI | decision 15 |
| The owner hashes a binary, then spawns it by path; a stream whose reader stalls stalls the session until a timeout; one group kill after exit leaves a pid-reuse window | before phase 6 |
| The plugin-binary lint misses a name built without `runbooks-` in one string | if it matters |
| An unknown error kind's raw name, and `values` detection-source values, are not scanned for secrets | phase 3 |
| The contract suite has offline scenarios built in for AWS only. runbooks-plugins wrote Google's and Azure's (2026-11-26; scratchpad `contract-scenarios/`); they go into the tree with the lock PR. Against the v0.2.0 darwin_arm64 binaries: aws `5 pass`, google `5 pass`, azure `2 pass 3 fail` (`select` before sign-in answers invalidParams; an unknown sign-in field isn't refused; no `az` here). Plugins #50 and #51 fix the first two for a 0.2.1 | row 98, against the first release that passes |
| A bad `RUNBOOKS_OUTPUT` gives `Invalid value for flag --output: "config". Expected: SchemaError(...)`: it names neither the value given nor the variable, and says "flag" though none was given (runbooks-reviewer on #627) | phase 3, with the CLI's help and errors |
| From group 9 (#632 to #634): in block views, `window.` and `self.` get around `no-restricted-globals`; the import ban names `bun`, `bun:sqlite`, `bun:ffi`, not `bun:*`; the graph test covers `block.ts` only, treats npm packages as leaves and takes each alias's first target; `fs.readdir` still lists a folder whole; a walk that stops when its reader stops is untested; `unbornBranchName` has no caller | if they matter |
| Dev mode is not wired to `fakeCredentialProviders`; `just dev` does not fetch plugins; nothing reads the shipped `plugins.lock` | phase 3 |
| Bump `resources/plugins.lock` to the plugins release that sends `envValue.file` | track A, when released |
| Real Developer ID signing and notarization with `mac.signIgnore` | the first release run |
| A large org's target list can pass the 1 MiB line cap (the plugins answer `internal`): page `targets` | a later contract change |
| The `rebuild/main` review at 17064004, groups still to fix: the schema byte check, with row 98 (group 10; the protocol stays "1"); parse smalls, `literalOnly`, owner TOCTOU and stdout close (group 13); hash-then-spawn (group 14, before phase 3). Groups 8 and 11 are done (#612 to #620, #624, #625), group 12 is #627 to #630, and group 9 is #632 to #634 | row 97, one subagent at a time |
| Inferred from that review, not reproduced: a second Ctrl-C or SIGTERM and process groups; run files 0644 in tmpdir; `valueLength` 128K over `MAX_ARG_STRLEN`; `agentAccess`/`confirmAgentRuns` not read (gate before MCP) | reproduce first |
| `boilerplate.yml` readers (`config.ts:388`, `warmEligibility.ts:95`) move to `yamlData` | phase 4, Template |
| `openFileTail.finish()` reads what is left of a log file in one go when the child ends (#594) | before phase 6 |
| Command has no `exclusive` prop (`validate` warns it is ignored) | phase 3, with run order |
| No saved session keeps `BlockView.files` (#602) | phase 5, the files panel |
| Template and TemplateInline report their files as `File` events, so `files_generated` counts them | phase 4, Template |
| Old-tree CI flakes: `GitAuth.switch` Reload (a stale-effect race), and `SessionName.test.tsx`'s refused-name focus check (#603's first run) | before phase 6, or with the old tree's deletion |
| Opening a 3200-block runbook takes 42 to 57 times a 200-block one (16 times the blocks), even with #608: something in open or parse grows faster than linear past about 800 blocks. Not investigated | with the bounds (row 97) |
| `if hasKey` stays refused in `env` (runbooks-reviewer). GitClone's optional output: the block always gives it, empty when it doesn't apply, and a script tests `[ -n "$X" ]` | phase 4, GitClone |
| Check must declare `scripts`, so its script makes no edges | phase 4, Check |
| A sessions database that can't be used (damaged, foreign, newer) is only an `Effect.logWarning`; the person must see it, as settings' `problems` | phase 3, when the database is wired |
| Two stores on one settings file, as two Runbooks, can lose one's change: each writes back what it holds (#625 Gaps) | if a second writer becomes real |
