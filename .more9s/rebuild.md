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
- Later on 2026-11-26 (14:51 UTC) the human merged #626 to #639 the same way (`rebuild/main` d2c172ed), and ruled #640's `<style>`: refuse it. GitHub rebased #640 to #648 onto `rebuild/main`, patch for patch (`git patch-id --stable` before and after). #640 then gained its behaviour-changes row (fca0c8e9), and #641 to #648 were restacked onto it with leases pinned to GitHub's heads. This index commit leaves #640 one commit behind; it is not restacked.
- Later on 2026-11-26 the human merged #640 to #648 the same way (`rebuild/main` f748174a). GitHub rebased #649 onto it (89592206), patch for patch, so it is not force-pushed from here; this index commit leaves it one commit behind.
- Later on 2026-11-26 #649 and #650 passed runbooks-reviewer and were marked ready. #650's review found that nothing bounds how deep a runbook nests (Electron main ran out of stack on 500 nested quotes), so rows 3g2a (#652, the `tooDeep` code) and 3g2b (#653, the parser's limit) went in above 3g2, and 3g3 is based on 3g2b.
- At 19:17 UTC on 2026-11-26 the human merged #649 to #651 the same way (`rebuild/main` 83c6d949). GitHub rebased #652 onto `rebuild/main` (653e23b0) and #653 onto it (bea07178), patch for patch, so they are not force-pushed from here. Row 3g3 lost watch mode to a row of its own after 3j: its spec runs Command blocks in the window, and a reload has to meet the trust prompt.
- At 19:35 UTC the human merged #652 and #653 (`rebuild/main` bec13f26), and GitHub rebased #655 onto `rebuild/main` (5def7eec), patch for patch. Track A's lock PRs (#656 to #658) went on #655 once plugins v0.2.1 was released, and phase 3 continues above them: #659 (a contract change the window needs) and #660 (3g3).
- At 20:10 UTC the human merged #655 (`rebuild/main` 4b613f21), and GitHub rebased #656 to #660 onto `rebuild/main`, patch for patch. #656 to #659 passed runbooks-reviewer and are ready. #660's review found that a ref lookup or clone whose server never answers hung forever; d0b32d65 bounds every git's wait in `gitSpawnEnv`. The reviewer's notes on #656 and #657 (no check that a pin is the release's, on platforms CI doesn't fetch) became #662, on top. At 21:02 UTC the human merged #656 to #659 (`rebuild/main` 8d560225); GitHub rebased #660 and #662 patch for patch, and the reviewer confirmed both passes for the new heads, so both are ready. Row 3h is three PRs above #662: #663 (contract), #664 (`BlockFrame`), #665 (instruction mode).
- On 2026-11-27 the index's own commits had left #660 behind `rebuild/main`, so #660 and #662 to #665 were restacked, patch for patch, and runbooks-reviewer passed their new heads. Row 3i landed as #670 (contract: `DocumentBlock.Configured.effects`) and #671 (the trust prompt); #671 failed review once (a credential block waiting for trust was untested, 425ca0e7). Row 3j's first part is #672 to #676; its other two parts are rows 3je and 3jf. The follow-up "a run gets the hashed script texts" is closed: #587 gave a task its files through `TaskReads`, which instruction mode builds with no I/O.
- At 06:17 UTC on 2026-11-27 the human merged #660, #662 to #665 and #670 to #676 the same way (`rebuild/main` e232dcf9, whose tree equals #676's head), and GitHub rebased #677 to #679 onto it, patch for patch. Row 3je landed as #677 to #679. #678's review found that a form whose title read its own optional field couldn't be submitted with it empty, so a title or a description now holds nothing (d873a09d), and the block's own form got its test (406dc08d); #679 then took a `Quiet` task for its no-commands cases. Row 3jf landed as #680.
- Later on 2026-11-27 the human merged #677 to #682 the same way (`rebuild/main` 12f13baa, whose tree equals #682's head 610466c8), ruled three watch-mode questions (Other rulings, below) and ruled work product 0.13 done. GitHub rebased #684 and #685 onto it. Row 3j2's engine work landed as #684 (the reload) and #685 (files on disk, `ReloadFiles`). #685 passed runbooks-reviewer and was marked ready; #684's review found that a watcher reload saved trust for the new hash, which the human then ruled out. Both are reworked, #685 goes back to draft, and both return to runbooks-reviewer with row 3j2e (the watcher). All 85 choices of my own built so far are on one page for the human, each with a suggestion (Choices of my own, below).
- Later on 2026-11-27 row 3j2 went on: #684 to #692 passed runbooks-reviewer and are ready. #684 and #685 were reworked for the saved-trust ruling, and #685 gained a `chosen` flag: trust is saved only over a document a person trusted or chose. #686 is the watcher. Its review asked for a test that runbook saves don't delay a notice in `notice` mode (#687), and for a failed watch to reach the window: #688 is the `Unwatched` contract, and #689 is the engine, where the Node layer fails a watch past Linux's limit with `FileWatchLimitError`, by its code. #690 is the window (3j2f); its review made a changed runbook's trust prompt take its hash and blocks from one read. #691 moves `BlockLink` into its own module, and #692 is the frame's "Script changed" notice (3j2g). The e2e port is no longer a row of its own: 3j2h ports `watch-mode.spec.ts` tests 1, 3 and 4 with the flags, and new rows 3j2i to 3j2k build Command's source view (`GetScriptFiles`), which test 2 needs, and port test 2.
- At 05:35 UTC on 2026-11-28 the human merged #684 to #695 the same way (`rebuild/main` 9929f761), and GitHub rebased #696 onto it (72f67686, the tree of the 00258e1e that passed review). At 05:46 UTC the human merged #696 (`rebuild/main` 241285cf), which completes row 3j2 and work product 3.1. Row 3k (Inputs end to end) opened as #698 to #700 (3k1a, 3k1b, 3k2), which GitHub rebased onto `rebuild/main` in turn; this index commit leaves them one commit behind. The human ruled three Inputs questions (H1 to H3) and choices-page entry 11, the `[account]` contract cases (Other rulings, below).
- **Keep it stacked.** The open PRs are GitHub stack #628, based on `rebuild/main` (`gh api repos/gruntwork-io/runbooks/stacks/628`); #519 holds #496 to #598, and #614 holds #599 to #625. `.more9s/stack.sh` keeps it that way:
  - `add <branch> <title> <body-file>` opens each new PR as a draft on the top of the stack, links it into #628, and waits until GitHub lists it on top (two adds in a row once based the second on the PR below the first). Once it is green, send it to runbooks-reviewer, and mark it ready with `gh pr ready` only when the review passes. Don't open a rebuild PR with `gh pr create` alone.
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
| 96q | #626 | 2 | `rebuild/p2-review-smalls` | `rebuild/main` | merged | runbooks-reviewer's notes on #621, #623 and #625: the `{{ "{{" }}` hint, `Object.hasOwn`, a refused task's props not read, `replaceWith`'s own error |
| 96r | #627 | 2 | `rebuild/p2-cli-contract` | p2-review-smalls | merged | review group 12: `validate` reads `RUNBOOKS_OUTPUT=junit` as text; a test file that can't be loaded fails its runbook's `config` test |
| 96s | #629 | 2 | `rebuild/p2-task-time-limit` | p2-cli-contract | merged | contract change: `TaskBlock.timeLimit`, kept by the engine |
| 96t | #630 | 2 | `rebuild/p2-test-ignores-timeouts` | p2-task-time-limit | merged | review group 12: `runbooks test` ignores a block's own time limit, as today (`blockTimeLimits`) |
| 96u | #631 | 2 | `rebuild/p2-load-flakes` | p2-test-ignores-timeouts | merged | three tests that failed with other suites running (#620's second writer, #608's one-pass ratio, the CLI tests' case-folder check), and #608's Blocked note |
| 96v | #632 | 2 | `rebuild/p2-core-environment` | p2-load-flakes | merged | review group 9: the core reads the app's environment only through `Environment` |
| 96w | #633 | 2 | `rebuild/p2-lint-gaps` | p2-core-environment | merged | review group 9: the lint gaps, and a test of each `block.ts`'s import graph |
| 96x | #634 | 2 | `rebuild/p2-walk-bound` | p2-lint-gaps | merged | review group 9: a walk holds at most 256 entries for its reader |
| 96y | #635 | 2 | `rebuild/p2-run-checked-bytes` | p2-walk-bound | merged | review group 14: a plugin runs from a copy made while hashing, in its own run folder, removed when the scope closes |
| 96z | #636 | 2 | `rebuild/p2-plugin-stdout-close` | p2-run-checked-bytes | merged | review group 13: a plugin that closes its standard output and keeps running is a protocol violation, after a bounded wait for its exit |
| 96aa | #637 | 2 | `rebuild/p2-parse-errors` | p2-plugin-stdout-close | merged | review group 13: a block inside a block that shows no markdown is `badChildren`; `path=""` is a bad prop; a quoted `runbooks` key's error is at its line; no error quotes what a prop holds |
| 96ab | #638 | 2 | `rebuild/p2-template-refs-linear` | p2-parse-errors | merged | review group 13: the template-reference scan is linear in the template |
| 96ac | #639 | 2 | `rebuild/p2-not-allowed-state` | p2-template-refs-linear | merged | contract change: `NotAllowed.state` is a closed set |
| 96ad | #640 | 2 | `rebuild/p2-literal-only-gaps` | `rebuild/main` | merged (the human ruled `<style>` refused) | review group 13: `literalOnly` refuses `<meta>`, `<base>`, `<link>`, `<style>` and `javascript:` markdown URLs; `metadataElements` in baseline/behaviour-changes.ts |
| 96ae | #641 | 2 | `rebuild/p2-renew-before-expiry` | p2-literal-only-gaps | merged | contract change: `env` refreshes a credential within 5 minutes of its expiry; the fake does, and the contract suite has a refresh case |
| 96af | #642 | 2 | `rebuild/p2-blocks-throw-nothing` | p2-renew-before-expiry | merged | `runbooks/no-throw-in-blocks`: block code throws nothing (runbooks-reviewer on #637) |
| 96ag | #643 | 2 | `rebuild/p2-cli-signals` | p2-blocks-throw-nothing | merged | review, inferred item: `runbooks test` stops on SIGTERM as on Ctrl-C; a second signal ends the stop at once; no process a script started outlives the CLI |
| 96ah | #644 | 2 | `rebuild/p2-run-env-bound` | p2-cli-signals | merged | review, inferred item: a run's environment fits what a process can be started with (131072 bytes a variable a block gives, 983040 in all); an output's value is capped in bytes |
| 96ai | #645 | 3 | `rebuild/p3-task-values-redacted` | p2-run-env-bound | merged | 3a, contract change: a task gets every form value it reads `Redacted` (`TaskValues`), as it gets outputs |
| 96aj | #646 | 3 | `rebuild/p3-document-view` | p3-task-values-redacted | merged | 3b, protocol change: `GetDocument` gives a client the document (tree, encoded props for display blocks and formless tasks, each block's errors); `FieldView` has `section` and `optionLabels`; a YAML error quotes none of the runbook (`parseYaml`). 3.2 (part) |
| 96ak | #647 | 3 | `rebuild/p3-form-outputs` | p3-document-view | merged | 3c, contract change: a form output names the field it carries (`FormOutputDecls`), sensitive when the field is; an output naming a missing field is refused at open; the test CLI's `set_outputs` goes to fields |
| 96al | #648 | 3 | `rebuild/p3-app-window` | p3-form-outputs | merged | 3d and 3e, 3.1 (part): `app-main` opens the one window (sandboxed, context-isolated, a CSP without `'unsafe-eval'` or inline script, navigation and new windows refused, permissions denied, an in-memory partition, user data in `<appData>/runbooks-rebuild`); `app-renderer`'s tsconfig maps only the protocol and the views (a compile error otherwise); `electron.vite.app.config.ts` into `app-out/`, `just app-build`, `app-dev`, `app-test-e2e`; an e2e of the window in CI |
| 3f | #649 | 3 | `rebuild/p3-ipc-transport` | `rebuild/main` | merged | 3.1 (part): main hosts the engine, its files in userData; the IPC transport (main, preload, renderer client) with the IPC sender check, the page's messages bounded (1 MiB each, 1024 queued); quit waits for the stops' grace, at most 10 seconds; the rebuilt app's e2e on one shared launch fixture (`e2e/fixtures.ts`, `chromiumSandbox: true`) |
| 3g | #650 | 3 | `rebuild/p3-renderer-walk` | 3f | merged | 3.2: the window opens the runbook given on the command line, or shows a welcome screen; one app per user data folder; the renderer walks `DocumentView`: literal props, MDXContainer's security rendering half, a misconfigured block's errors in place of its view, the body in a `contain: paint` box; the app's CSS under `style-src 'self'`, and a dev CSP; a defect while opening or showing the runbook is said, not a window left asking |
| 3g2 | #651 | 3 | `rebuild/p3-runbook-assets` | 3g | merged | 3.1 (part): the page from `runbooks-app://window/`, so `'self'` isn't every `file://` URL; a runbook's assets from `runbook-asset://<session id>/` behind the path guard, byte ranges streamed as the window pulls them (`stream` and `standard` pinned by the seek e2e); `img-src`/`media-src runbook-asset:`; the seven served-asset tests ported by name; `runbook-assets.spec.ts` ported |
| 3g2a | #652 | 3 | `rebuild/p3-too-deep-contract` | `rebuild/main` | merged | contract change: `tooDeep`, a runbook nested too deep is refused |
| 3g2b | #653 | 3 | `rebuild/p3-nesting-bound` | 3g2a | merged | the parser refuses a runbook nested more than 100 levels (`MAX_NESTING`), before any walk that recurses; e2e against Electron's stacks |
| 3g2c | #655 | 3 | `rebuild/p3-nesting-order` | `rebuild/main` | merged (4b613f21) | a test pins `nestedTooDeep`'s first-in-document-order report (runbooks-reviewer's note on #653) |
| 3g3a | #659 | 3 | `rebuild/p3-list-order` | 100 | merged (8d560225) | contract change: `ListSessions` lists sessions in the order they opened, which 3g3's window relies on |
| 3g3 | #660 | 3 | `rebuild/p3-open-url` | `rebuild/main` | merged | 3.1 (part): open a runbook from a URL on the command line (the old app's clone, in main; clones in `<userData>/v0/clones`); a second launch opens its runbook in the running app, which reloads the page |
| 100a | #662 | A | `rebuild/pA-plugins-pins` | 3g3 | merged | A.5: CI checks every lock pin against the pinned release's `SHA256SUMS`, on all five platforms (the reviewer's note on #656 and #657) |
| 3ha | #663 | 3 | `rebuild/p3-frame-contract` | 100a | merged | contract change: `BlockView.instruction` (built before trust, values redacted), `SessionView.sequence` (where `Events` starts), `DocumentBlock.step` |
| 3h | #664 | 3 | `rebuild/p3-block-frame` | 3ha | merged | 3.3: `BlockFrame` for every block by class (step mark, status, blockers as links, auto-collapse), the window following `Events`, the task default view |
| 3hb | #665 | 3 | `rebuild/p3-instruction-mode` | 3h | merged | 3.3: instruction mode in the frame, followed through `WatchSettings`; Command's instruction in the old app's words |
| 3ia | #670 | 3 | `rebuild/p3-trust-contract` | 3hb | merged | contract change: a configured `DocumentBlock` carries its block's declared `effects` (empty for display and form blocks), for the trust prompt; the window can't import the registry |
| 3i | #671 | 3 | `rebuild/p3-trust-prompt` | 3ia | merged | 3.5: the trust prompt above the runbook's box, each block's effects in plain words; the ask with each failure's line and HashChanged's re-read; `e2e/trust.spec.ts` |
| 3ja | #672 | 3 | `rebuild/p3-log-line-contract` | 3i | merged | contract change: `LIMITS.maxLogLineLength` (16,384) on every `LogLine`; the `Log` task event's optional `cut` |
| 3jb | #673 | 3 | `rebuild/p3-log-line-cut` | 3ja | merged | a longer line is cut where it enters the run's log, with a note of how much (`linesCut` in Command, `logLine` in the engine) |
| 3jc | #674 | 3 | `rebuild/p3-stop-waits` | 3jb | merged | a stopped script's folders go once its processes have ended: the spawner's `kill` waits for the stop (5 s grace); `CancelBlock` answers then |
| 3j | #675 | 3 | `rebuild/p3-command-app` | 3jc | merged | 3.8 (Command, in the app): the task view lists outputs; the failure line gives the exit code once; `e2e/command.spec.ts` runs Command's test runbooks in place |
| 3jd | #676 | 3 | `rebuild/p3-instruction-guard-test` | 3j | merged | test: instruction mode sends no `CancelBlock` and no `ActOnCredential` (3h re-review); `app.tsx`'s leftover comment |
| 3jea | #677 | 3 | `rebuild/p3-gates-contract` | `rebuild/main` | merged | contract change: `Blocker` gains `EmptyInput {block, input}` and `Exclusive {block, runsAlone}`; `TaskBlock.exclusive(props)`, decided before trust |
| 3jeb | #678 | 3 | `rebuild/p3-input-wait` | 3jea | merged | 3.8 (Command): a block waits for each input its run is given (its own props and `env`, not `title` or `description`) to have a value, by #489's rule; the last form with the field is the one named |
| 3je | #679 | 3 | `rebuild/p3-exclusive` | 3jeb | merged | 3.8 (Command): `exclusive`; the engine holds a task that runs commands (the `process` effect) while one that runs alone runs, and the other way round |
| 3jf | #680 | 3 | `rebuild/p3-decision-8-testdata` | 3je | merged | decision 8: testdata's Commands declare every output their scripts write, in place, since the old tree ignores `outputs` (`validate` gave 18 undeclared reads in 4 runbooks; the 21 in 9 counted here before wasn't reproducible); baseline checks for reads, assertions and writes |
| 3j2a | #681 | 3 | `rebuild/p3-watch-contract` | 3jf | merged | contract change: watch mode. `DocumentView.hash`; `OpenSession.watch` (`WatchMode`: off, notice, runbook, runbookAndFiles; the reloading modes are person only); `BlockView.filesOnDisk`, bounded by `LIMITS.maxDiffChars`; `ReloadFiles`, person only, at the hash shown; `SessionView.reloadHeld`; `DocumentChanged`, `ReloadHeldChanged`, `FilesOnDiskChanged` |
| 3j2b | #682 | 3 | `rebuild/p3-live-reload-change` | 3j2a | merged | behaviour change (ruled): `--disable-live-file-reload` reloads inline commands too, and only named script files keep their text (`CHANGES.inlineCommandReloads`; `watch-mode.spec.ts`'s 4th test patched) |
| 3j2c | #684 | 3 | `rebuild/p3-watch-reload` | `rebuild/main` | merged | 3.1 (watch mode): a session reloads its document, keeping each block whose props (shared ones included, apart from `title` and `description`) and file hashes are as they were; trust is kept while the session is open and saved only for a hash a person trusted or chose |
| 3j2d | #685 | 3 | `rebuild/p3-files-on-disk` | 3j2c | merged | 3.1 (watch mode): the core Myers line diff; `BlockView.filesOnDisk` from what the watcher read; `ReloadFiles` takes the bytes shown, and saves trust only when the document it replaces was trusted or chosen by a person (`chosen`) |
| 3j2e | #686 | 3 | `rebuild/p3-watch-mode` | 3j2d | merged | 3.1 (watch mode): the engine's watcher per session through `FileSystem.watch`, debounced 300 ms, one queue per session; reloads held while blocks run, refused or unread (`reloadHeld`) |
| 3j2e1 | #687 | 3 | `rebuild/p3-watch-notice-test` | 3j2e | merged | 3.1 (watch mode), test only: in `notice` mode, runbook saves don't hold a script's notice back (#686 review) |
| 3j2e2 | #688 | 3 | `rebuild/p3-unwatched-contract` | 3j2e1 | merged | contract change: `SessionView.unwatched` and `EngineEvent.Unwatched`, a session that stopped watching (#686 review) |
| 3j2e3 | #689 | 3 | `rebuild/p3-unwatched` | 3j2e2 | merged | 3.1 (watch mode): a failed watch sets `unwatched` with what to do; the Node layer fails a watch past Linux's limit with `FileWatchLimitError` |
| 3j2f | #690 | 3 | `rebuild/p3-watch-window` | 3j2e3 | merged | 3.1 (watch mode): the window redraws on `DocumentChanged`, frames keyed by block id, the trust prompt sends `document.hash` (#671 Gaps), and page notes for `reloadHeld` and `unwatched` |
| 3j2f1 | #691 | 3 | `rebuild/p3-block-link` | 3j2f | merged | refactor: `BlockLink`, `frameId` and `scrollToBlock` move to `blockLink.tsx` |
| 3j2g | #692 | 3 | `rebuild/p3-watch-notice` | 3j2f1 | merged | 3.1 (watch mode): the frame's "Script changed" notice (`script-change-diff`, "Reload script" through `ReloadFiles`), with a note beside it when the diff is truncated |
| 3j2h | #693 | 3 | `rebuild/p3-watch-flags` | 3j2g | merged | 3.1 (watch mode): app-main maps its flags: none to `notice`, `--watch` to `runbookAndFiles`, `--watch --disable-live-file-reload` to `runbook`; `watch-mode.spec.ts` tests 1, 3 and 4 ported (test 4 as 3j2b patched it) |
| 3j2i | #694 | 3 | `rebuild/p3-script-files-contract` | 3j2h | merged | contract change: `GetScriptFiles {session, block}` gives the session's held text of each script file a block runs; `DocumentBlock.scriptFiles?` names them; `LIMITS.maxScriptChars` |
| 3j2j | #695 | 3 | `rebuild/p3-script-files` | 3j2i | merged | 3.1 (watch mode): the engine answers `GetScriptFiles` from the held text, with `{{ }}` left as text and no value in it |
| 3j2k | #696 | 3 | `rebuild/p3-source-view` | 3j2j | merged | 3.1 (watch mode): the frame's "View Source Code", read again on `DocumentChanged`; `watch-mode.spec.ts` test 2 ported |
| 3k1a | #698 | 3 | `rebuild/p3-value-depth` | `rebuild/main` | in review | fix: `MAX_VALUE_DEPTH = 32` on `FieldValue`, checked by a walk with its own stack before the recursive decode, so a value nested too deep is a schema error, not a stack overflow; `parseYaml` says its lists and maps nest too deep |
| 3k1b | #699 | 3 | `rebuild/p3-form-contract` | 3k1a | in review | contract change: `Section.collapsed` (`Section.fields` goes: a field names its section), `BlockView.sections`, `FieldView.schema` and `schemaInstanceLabel`, `nestedIn` on a task's own form, and `FieldView.description` as a `TreeNode` the core parses (`markdownTree`; the walk's allowlist moves to the core as `MarkdownPart`) |
| 3k2 | #700 | 3 | `rebuild/p3-form-engine` | 3k1b | in review | 3.8 (Inputs), engine: fields in section order; a hidden field with an error shown, locked; only valid values for readers; a `{{ }}` default and `optionsFrom` refused as not built yet (3k8); a task's own form (`nestedIn`) is no step and has no Submit |
| 3k2b | none | 3 | `rebuild/p3-values-after-submit` | 3k2 | building | behaviour (ruled H1, 2026-11-27): a form's readers get its starting values until its first Submit, then each change live, as today; reverses #532's live-before-Submit |
| 3k3 | none | 3 | `rebuild/p3-inputs` | 3k2b | building | 3.8 (Inputs): `blocks/inputs/` (definition, docs page, tests, testdata), the shared boilerplate reader, registered in place of the stand-in; a malformed setting is a configuration error (H2); a duplicate id does not register |
| 3k4 | none | 3 | `rebuild/p3-inputs-cli` | 3k3 | planned | test CLI: test inputs decode as `FieldValue` (the `as never` cast goes), `fuzz` ported, `boilerplate.yaml` read as well as `.yml` (H3); `runbooks test` passes Inputs' testdata and pseudo-tty |
| 3k5 | none | 3 | `rebuild/p3-instruction-reads` | 3k4 | planned | the window reads every task again on each value or output change, for its instruction, with instruction mode off too (#664); gate that on instruction mode, or a keystroke rereads every task |
| 3k6 | none | 3 | `rebuild/p3-form-view` | 3k5 | planned | 3.3: the window's form view, from `BlockView.fields` and `sections`: a control per type, folding sections, locked, hidden-with-error and sensitive fields, Submit, per-field Reset, a task's own form drawn inside it; a `FormView` a task's form reuses |
| 3k7 | none | 3 | `rebuild/p3-inputs-e2e` | 3k6 | planned | 3.8 (Inputs): `e2e/inputs.spec.ts`, ported from the kitchen-sink, homepage-demo, demo3 and next-app checks |
| 3k8 | none | 4 | `rebuild/p4-linked-defaults` | before Template | planned | linked defaults (a `{{ }}` in a default) and options from an output (`optionsFrom`), which 3k2 refuses until built; Template needs both |
| 3l | none | 3 | `rebuild/p3-admonition` | 3k7 | planned | 3.8 (Admonition) |
| 3m | none | 3 | `rebuild/p3-aws-auth` | 3l | planned | 3.4 and 3.8 (AwsAuth): the common auth view; AwsAuth against the fake; dev mode wired to `fakeCredentialProviders`. Also: instruction mode draws a text step's markdown as plain text (#665), which a credential's instruction would show with `**` and backticks |
| 3n | none | 3 | `rebuild/p3-session-database` | 3m | planned | the session database wired by the app's entry; its warnings shown |
| 3o | none | 3 | `rebuild/p3-agent-confirm` | 3n | planned | 3.7: agent run confirmation in the engine; `agentAccess`/`confirmAgentRuns` read |
| 3p | none | 3 | `rebuild/p3-mcp` | 3o | planned | 3.6: the MCP tools from the protocol, on both transports; the `SetValues` cap |
| 3q | none | 3 | `rebuild/p3-done-when` | 3p | planned | phase 3's Done when: the four blocks in the app, the test CLI and MCP; the CSP; a secret typed into AwsAuth in no event |
| 97 | none | 2 | the rest of the `rebuild/main` review's fixes | none | done | every group is fixed: #590 to #644, and group 10 in #657 |
| 98 | #656 | A | `rebuild/pA-plugins-lock` | `rebuild/main` | merged (1414853f) | A.5 (`resources/plugins.lock` pinning v0.2.1 on five platforms, its loader); Google's and Azure's offline contract scenarios built in |
| 99 | #657 | A | `rebuild/pA-plugins-recipes` | 98 | merged (000c8d21) | A.5 (fetch, check and bump recipes); group 10: CI checks `plugin/*.schema.json` against the pinned release's |
| 100 | #658 | A | `rebuild/pA-plugins-packaging` | 99 | merged (ee863b8c) | A.6 (CI and release check the bundled binaries; `mac.signIgnore`; the reviewer built the packaged app on v0.2.1) |

On 2026-11-24 the human found the PRs were not properly stacked:
- #496 lacked four index commits on `rebuild/main`. Every branch was rebased; trees were unchanged apart from this file.
- The PRs were not linked as a GitHub stack. They now are, with `gh stack link --base rebuild/main 496 … 518` (gh-stack v0.2.0), which created stack #519.

Phase 1 ended with #526 on 2026-11-24. Phase 2's work products ended with #581 (merged 2026-11-25); #582 is a contract addendum. Command landing in phase 2 is my choice: the Done when needs a Command fixture in the test CLI, and the registry is empty until it lands. #589 carries phase 2's Done when, and #597 replaces its exit test with one that can fail. runbooks-reviewer's review of `rebuild/main` at 17064004 asked for changes, so the phase 2 fix PRs (from #590) come before track A. Rows 87 to 96 are that queue so far, in the order the reviewer's findings and the docs subagent's report asked for them. The phase 2 fixes ended with #644. Track A's two lock PRs and its packaging PR wait for the plugins 0.2.1 release (the protocol stays "1", the human's ruling), which is the human's to make, so phase 3 started first, with #645 on 2026-11-26. Nothing before the app starts a real plugin (row 3m and later) reads the lock, and the lock PRs open on the stack's top once the release lands.

## Track A: gruntwork-io/runbooks-plugins

The Rust sign-in binaries, on the gruntwork-io-team/rust-base template, as GitHub stack #9 in that repo. **Since 2026-11-25 a separate `runbooks-plugins` Claude session owns it** (the human's instruction): send it plugin work, contract changes and CI findings; don't push there from this session.

- Stack #9 (#7, #8, #10 to #28) was merged by the human on 2026-11-25 (19:40 to 19:49 UTC); main bece31c. The unpushed branches `track-a/schema-resume`, `resume-from-values` and `google-tls-error` were handed to that session.
- `schema/credential.schema.json` there must stay byte-identical to `plugin/credential.schema.json` here. A contract change here is sent to that session with its PR number.
- v0.1.0 was published on 2026-11-25 (tag v0.1.0, a423b78): 12 binaries for darwin arm64 and amd64, linux amd64 and windows amd64, plus `SHA256SUMS`; assets are `<bin>_<ver>_<os>_<arch>[.exe]`. No linux arm64 (the human's call; the lock leaves it out, so the owner answers `notInstalled`). A.5 and A.6 are built on `rebuild/pA-plugins-*` (rows 75 to 77).
- Contract changes since the handover, sent to that session with their hashes: #574 (`callTimeoutsMillis`), #575 (`envValue.file`), #582 (no answer at end of input). v0.1.0 ignores `callTimeoutsMillis` but fails `env` without `file`, so the lock moves to the next release before any block uses a real binary.
- A.6 (the hash check): the owner checks the pinned hash before every start (#572). electron-builder would re-sign bundled Mach-O binaries and change their bytes, so `mac.signIgnore` leaves the plugin binaries as their release signed them; proven on a local ad hoc package (byte-equal, Developer ID kept), unproven with real signing and notarization until a release run.
- Since 2026-11-26 that session copies the schemas from `rebuild/main` (at d845152e: `base.schema.json` ce6348b7, `credential.schema.json` 846beb2a). Its open PRs: #36 (Azure `error_line` past a wrapper's first line, for #520) and #37 to #39 (resume from saved values, Google TLS errors).
- #641 changes `envResult`'s description (the 5-minute refresh window). runbooks-plugins #53 copies it byte for byte; #641 is on `rebuild/main` since f748174a (2026-11-26), and that session was told. Its aws plugin already refreshes within 5 minutes (`REFRESH_MARGIN`); google and azure answer no `expiresAt` for a credential they can refresh.
- **The plugin protocol stays at version "1"** (the human, 2026-11-26: "we should not uptick the protocol to 2, no one uses it yet. Let's start at 1. Keep the variable value for the protocol version though"). `PROTOCOL_VERSION` stays in `packages/core/src/plugin/transport.ts` as "1"; runbooks-plugins dropped its held bump, so 0.2.0 (its #49) speaks "1". Row 98 pins 0.2.0, with a CI check that `plugin/*.schema.json` are byte-equal to the release's schema assets.
- Crates approved by the human: serde, serde_json, thiserror, tokio, reqwest (rustls), time, typify, jsonschema and tempfile (dev), aws-config, aws-sdk-sts/sso/ssooidc/iam/account, aws-runtime, aws-types, aws-smithy-http-client, rustls, base64, subtle, libc, windows-sys. Any other direct crate is ask-first; transitive ones are vetted in the PR body.

## Work products

| WP | Item | PR | State |
|---|---|---|---|
| 0.1 | Rulings on the 18 open decisions | none | done: all 18 ruled (2026-11-26: 9 as written in its row, 15 as Windows supported, the rest as recommended) |
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
| 0.13 | Throwaway prototype | none | done: the human ruled it done on 2026-11-27, since phases 2 and 3 built its path for real (Command through the engine from the app, #675, and from the CLI) |
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
| 3.1 | The app frame: window, IPC transport, CSP without `'unsafe-eval'`, asset serving, path guard | #648 (the window, the CSP); #649 (the IPC transport); #650 (open from the command line); #651 (assets, path guard, the page's own scheme); #660 (URL, a second launch); row 3j2 (watch mode) | #648 to #651, #660, #681, #682, #684 to #696 merged |
| 3.2 | The renderer that walks the document | #646 (`GetDocument`); #650 (the walk); #653, #655 (a runbook's nesting bounded) | #646, #650, #653, #655 merged |
| 3.3 | `BlockFrame` and the default view for each class | #663, #664, #665 (the form and credential views land with rows 3k and 3m) | #663 to #665 merged; 3k6, 3m planned |
| 3.4 | The common auth view | row 3m | planned |
| 3.5 | The trust prompt, listing each block's declared effects | #670 (the effects in the document), #671 (the prompt) | merged |
| 3.6 | The MCP tools generated from the protocol, on both transports | row 3p | planned |
| 3.7 | Agent run confirmation in the engine | row 3o | planned |
| 3.8 | Command, AwsAuth, Inputs and Admonition, end to end | #645 (values redacted), #647 (form outputs); #672 to #676 (Command in the app); #677 to #679 (the input wait, `exclusive`); #680 (decision 8 in testdata); rows 3k, 3l, 3m, 3q | #645, #647, #672 to #680 merged; 3k1a to 3k2 (#698 to #700) in review; 3k2b, 3k3 building; 3k4 to 3k7, 3l, 3m, 3q planned |
| A.1 | The binaries' repo, with its build, signing and release | runbooks-plugins | done (that session) |
| A.2 | The AWS binary | runbooks-plugins | released v0.1.0 |
| A.3 | The Google binary | runbooks-plugins | released v0.1.0 |
| A.4 | The Azure binary, wrapping `az` | runbooks-plugins | released v0.1.0 |
| A.5 | `resources/plugins.lock`, the fetch recipe and the bump recipe | #656, #657; #662 (every pin checked against the release) | merged |
| A.6 | The hash check before a binary starts | #572; #658 for the packaged bytes | #572, #658 merged |

## The 18 decisions

On 2026-11-26 the human ruled every one but 15 as the plan recommends ("let's roll with these recommendations"), after reviewing this table. 9 was ruled earlier, as written below. 15's recommendation was itself to decide whether Windows is supported or instruction mode only; asked, the human chose **supported**. 4 (the API audit's renames left out of the rebuild) and 14 (fix today's four behaviour bugs on `main` as four small PRs) need no row of their own above; 14's PRs are queued after row 3h.

Each row names the PR whose description carries the Decisions entry.

| # | Ruled (the plan's recommendation, unless the row says otherwise) | First PR |
|---|---|---|
| 4 | The API audit's renames (one set of `detectCredentials` rules, one output casing, one name for scopes) are left out of the rebuild release | none |
| 14 | Today's four behaviour bugs are fixed on `main` now, as four small PRs: pull request events shared across blocks (I5), OAuth expiry detected by substring (B2), the test CLI dropping all but one auth reference (A1), opposite `gitAuthId` precedence in two blocks (A2) | against `main`, all ready (runbooks-reviewer passed): #666 (A2), #667 (A1, plus tests from review), #668 (B2), #669 (I5). Each failed nothing but the review's untested paths, now tested |
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
| 15 | Ruled 2026-11-26: **Windows is supported**, so blocks run there. That needs Windows CI for the engine and blocks, scripts that run on Windows, and a signed Windows build (follow-up row below). Until those land, environment names compare case-sensitively, as #539 built | #539 |
| 6 | Saved sessions keep form values and credentials, drop run history from older versions | #544 |
| 16 | One repo, one version for all binaries, hashes checked against the release's `SHA256SUMS` | #656 |

Other rulings, not among the 18:

| Ruled | What | Where |
|---|---|---|
| 2026-11-26 | `<style>`, `<meta>`, `<base>` and `<link>` in a runbook are refused ("refuse it") | #640 |
| 2026-11-26 | The plugin protocol stays at version "1" | #641, #663, #670 |
| 2026-11-27 | A reload keeps the session's trust while it is open, for the new hash ("Keep trust in watch mode"), and `ReloadFiles` is person only | #681, #684 |
| 2026-11-27 | `--disable-live-file-reload` keeps only named script files at their text; inline commands reload ("Only script files") | #682 |
| 2026-11-27 | Saved trust after a watcher reload: "This session only". Only a hash a person trusted (`TrustSession`) or chose (`ReloadFiles`) is saved as trusted, so reopening a runbook the watcher reloaded asks again | #684, #685 |
| 2026-11-27 | Work product 0.13, the prototype, is done ("you finished the final result") | Work products |
| 2026-11-27 | Inputs H1, "Defaults until Submit": a form's readers get its starting values until its first Submit, then each change live, as today. This reverses the first half of choice 34 (#532's values live before Submit); a person's edit still un-reviews a value an agent set | 3k2b |
| 2026-11-27 | Inputs H2: a malformed form setting is a configuration error, not a warning: a non-integer `order`, a non-boolean `x-locked` or `x-hidden`, a malformed `x-show-when`, `x-sections` naming no section, a duplicate variable name, a `prefilledVariables` name the form lacks | 3k3 |
| 2026-11-27 | Inputs H3: `runbooks test` reads `boilerplate.yaml` as well as `boilerplate.yml`, as the app does | 3k4 |
| 2026-11-27 | The credential contract's `[account]` cases (choices page 11): the human provides test credentials for the first setup and a supervised run; later, CI fetches ephemeral OIDC credentials to set up the fixture. They are not expected to run locally | Follow-ups owed |

Choices of my own that need a ruling (not among the 18). All 85 built so far, each with the decision, a suggestion, what it means and the suggestion's impact, are on the page https://claude.ai/artifact/JEuPt5qqeeB22XVE6c8SpL (2026-11-27), numbered 1 to 85; the human rules by those numbers, and an entry not ruled stays as built. The rows below are this index's list; the page's entries it lacked are added at the end as "Page n".

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
| Instruction mode copies a command by selection (`user-select: all`), with no Copy button: the page holds no clipboard permission. A button needs the permission allowed, or main to copy | #665 |
| A done task or credential block folds when it asks to (`autoCollapse`), so Finish and Template now fold; a form never does | #664 |
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
| Track A's lock PRs open on the stack's top once plugins 0.2.1 is released. Phase 3 started first: the release is the human's, and nothing before the app runs a real plugin reads the lock | row 98 |
| The lock is `{ plugins: PluginEntry[] }`; fetch is all or nothing and removes unpinned plugin binaries; bump takes the plugins from `SHA256SUMS` (only `<bin>_<ver>_<os>_<arch>[.exe]` entries: since plugins #46 it also lists `*.schema.json`, which the schema byte check reads), cross-checked both ways with the API's digests | rows 90, 91 |
| Plugin settings: AWS `defaultRegion`; Google `defaultRegion`, `defaultZone`; Azure none. No settings declaration in the contract (with runbooks-plugins: a refusal names the valid ones) | phase 3 |
| After a restart an AWS SSO or role login comes back as plain keys that cannot refresh: carrying the SSO token needs a secret at rest in `stateDir` (not built) | runbooks-plugins resume follow-up |
| runbooks-plugins keeps rust-base's `unsafe_code = "forbid"`: Azure's process tree uses std plus `/bin/kill` and `taskkill.exe`, not the approved libc/windows-sys FFI; Windows ACLs on `stateDir` wait on the same ruling | runbooks-plugins #24 |
| An unknown block is one error per use; a regex prop value is `badProp` | #517 |
| Edges name blocks by index | #518 |
| `githubAuthId` on a block with its own git-credential prop (GitClone, GitHubPullRequest) is that prop's alias, not an `envFrom` source | #517 |
| A cycle is one error per set of blocks that wait for each other, at its first block, naming the shortest loop | #521 |
| `syntax`, `notAllowed`, `unknownBlock`, `versionRequired` and `tooDeep` (#652, more than 100 levels: #653) refuse the runbook; every other error stops its block (`Misconfigured`), and the second of two blocks with one id is the misconfigured one | #522 |
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
| Page 16: Files are read once, at open | #587 |
| Page 17: A task gets only the outputs it names | #587 |
| Page 22: Copies into `$GENERATED_FILES` | #603 |
| Page 23: `$REPO_FILES` and where a Command starts | #603, #605 |
| Page 25: Any nested form feeds its task | #599 |
| Page 26: A block's file list | #602, #604 |
| Page 28: Environment size limits | #644 |
| Page 29: Cancel waits for the script to stop | #674 |
| Page 30: Long log lines are cut | #672, #673 |
| Page 31: What an `env` value may hold | #621 |
| Page 32: What `exclusive` holds | #679 |
| Page 33: testdata declares its outputs in place | #680 |
| Page 35: An empty optional field still gives its output | #647 |
| Page 36: Which reads hold a block | #678 |
| Page 42: `envFrom` takes one id or a list | #592 |
| Page 43: Ids that differ only in case | #591 |
| Page 44: YAML aliases | #593 |
| Page 46: SIGTERM and forced stops | #643 |
| Page 47: `validate --output junit` | #627 |
| Page 49: Where the rebuilt app keeps its data | #648 |
| Page 50: Permissions and outside links | #648, #650 |
| Page 53: A second launch | #660 |
| Page 54: Opening a runbook from a URL | #660 |
| Page 55: Images and media | #651 |
| Page 56: Author styles and unknown elements | #650 |
| Page 57: Which blocks send props to their views | #646 |
| Page 58: The trust prompt's words | #671 |
| Page 59: Where outputs show | #675 |
| Page 60: Quitting waits for scripts | #649 |
| Page 62: A lost login | #609 |
| Page 67: Running a copy of the plugin binary | #635 |
| Page 71: The engine watches and diffs | #681 |
| Page 72: A reload keeps unchanged blocks | #681, #684 |
| Page 73: Agents can't reload | #681 |
| Page 74: Reload takes the bytes the diff showed | #685 |
| Page 75: A changed form's values need review | #684 |
| Page 76: Two opens of one runbook | #615 |
| Page 77: A damaged sessions database | #624 |
| Page 78: Settings are imported once | #619 |

## Waiting on the human

| What | Options | Where it shows |
|---|---|---|
| GitClone declares `push` for an empty remote, and a block that declares `push` may only `expect: skip`, but file-workspace, git-clone and inputs-and-outputs expect GitClone to succeed | GitClone declares its push apart from its clone (recommended), or the three steps skip (a tenth behaviour change) | `baseline/testFiles.test.ts` pins the three (#569) |
| `ShowWhen` is kept in the baseline as a display stand-in (#585) | keep it, or drop it from the baseline | the baseline list |
| The Azure plugin fails `detect` when its refresh fails (#520); today warns and goes on | keep failing (built), or warn and go on | runbooks-plugins |
| The master plan's line 218 shows `instruction(TaskInput)`; #587 made it `TaskReads` | update the plan | the master plan |
| A linux arm64 plugin binary | build it (runbooks-plugins built it, and v0.2.1 ships it, so #656 pins it; not ruled) or leave Linux on ARM `notInstalled` (drop the three `linux-arm64` pins) | `resources/plugins.lock` |
| A no-proxy list | a setting plus a contract change, or none | the credential contract |
| A link inside a folder a block names is refused (#595 Decision 1); `docs/intro/files_workspace.mdx:125-131` documents following links that stay in the folder | refuse (built), or follow a link whose real path is inside the runbook's folder | #595 |
| The 2000-entry cap on a named folder now counts folders as well as files (#595 Decision 2) | keep, or count files only | #595 |
| A block id is ASCII letters, digits, `-` and `_` (#590); authors see it as a parse error | keep, or widen the pattern | #590 |
| No `received` quotes a prop's text, `id` and `dependsOn` included, so a mistyped id shows `received: text` (#637 Decision 1; runbooks-reviewer agrees) | keep (built), or echo the text for id-like props | #637 |

## Failed attempts

| Check | Attempt | Result |
|---|---|---|
| #573's unit tests in CI | Read the message of a plugin that fails to load from oxlint's output | GitHub's runners default oxlint to its github format, which drops that message; the test asks for `-f default` (907fda47). |
| Generate TS from `plugin/base.schema.json` | `not: { required: [id] }` on notifications | Effect's importer: "Cannot import JSON Schema keyword \"not\"". Rule moved to the transport owner (#499). |
| Decision 9 in CI and review | List the places bash evaluates a word by lexing the script (#588), then patch the misses (#598) | Review rounds 1 and 2 each found classes that still ran a value. The premise, not the patch, failed; the human ruled env only (2026-11-26). |

## Follow-ups owed

| What | Where it lands |
|---|---|
| `src/` and its copies in `packages/` drift until the old tree goes | phase 6 |
| Command's `successMessage`, `failMessage` and `runningMessage` aren't drawn in the window, and an input they read holds the block like any own prop (#678 decision 1). When they are drawn, the definition marks which props are only shown, so those hold nothing | with the row that draws them |
| The input wait (#678 Gaps): inputs read in Template's files hold nothing (`fileReads` makes only output references); a path into a field that isn't a map, such as `.inputs.region.x`, waits forever (the old app did too); 15 testdata runbooks read inputs in `env`, and a test that leaves an optional field with no default empty is now held; no e2e shows the blocker. `runbooks test` never meets `Exclusive`, so its words are untested (#677) | phase 4, Template; the phase 6 gate |
| Check and Finish run alone by declaring `exclusive` and `process`; neither prop is built. In phase 4, Prerequisites both waits for and holds an exclusive task (#679 decision 1) | phase 4 |
| `runbook-assets.spec.ts` :175 and :197 refused the page's own first asset on CI (run 45944598540 attempt 1, job 140326306044; again on #686, run 46036683789 attempt 1): a possible race between the session's asset host and the first asset request (#651). A person could meet a first image or sound that doesn't load on open | investigate before row 3q |
| The old app's `electron/e2e/sessions.spec.ts:406` (the trust button stays visible) failed on #668's first run and #676's second attempt (job 140329357032); it runs on `main` PRs too | the human decides: a row or an issue |
| The cut note's character count is in UTF-16 code units (#673 review nit) | if it matters |
| GitGuardian incidents 27121678, 33923057, 33923058 re-raised by the copy | the human, in the GitGuardian dashboard |
| Decision 8 for Check: openclaw's Template file reads `check-root-hcl.has_root_hcl`, and script-env's test asserts on `print-title.title`; both Checks write those keys (#680 Gaps). No test checks reads by blocks not yet in the registry (TemplateInline, ShowWhen), and `electron/e2e/agent-access.spec.ts`'s `greet` writes `greeting` undeclared. The authors' table and the old docs lack declared outputs | phase 4, with Check; phase 6 docs |
| The MDXContainer security tests' rendering half (the page shows literal props) | row 3g |
| `rebuild/main` holds `main` to d7136710 (#585, #586); a later sync repeats the merge and the port command in #586's Evidence | before phase 6 |
| A block's errors show in place of its view (#522); #646 sends them | row 3g |
| `showWhenBlock`'s target check becomes a `run`-capability reference on Command, Check and Finish (#525 removed the old type list) | phases 3 and 4 |
| `<Iframe>` passes the literal-only check: a test in the Iframe block's folder (#525 moved the core's case to `<Script>`) | phase 4, Iframe |
| The block-name lint reads `baseline/props.json`; when the baseline retires, the registry alone names the blocks (#526) | phase 6 |
| Iframe's outputs (#647): no field can be kept for the window to set, so an agent's `SetValues` can set an Iframe's page fields; a page posting `""` no longer counts as set; `runbooks test`'s `set_outputs` with two outputs on one field keeps the last without a word (runbooks-reviewer) | phase 4, Iframe |
| The baseline's stand-in forms declare outputs over an empty field list (#647): opening a session on one would refuse it | when a stand-in is opened |
| A plugin-backed form needs a read after trust (Layer 3 against the trust rule) | phase 4 (contract change) |
| A person-picked checkout root, and Template targets in it | phase 4 |
| `NodeSessionDatabase` is first wired by the app's entry point; the test CLI keeps no saved sessions (#570) | phase 3 |
| `SetValues` payload (keys, value size) uncapped; a malformed payload from an untyped caller is untested | phase 3, MCP (the first untyped caller) |
| A `LogLines` event's total size is unbounded: every line since the last 250 ms flush, up to 10,000 lines of 16,384 characters (#672); `Events` sends every pending event as one chunk. A `log_*` file line over 64 KiB shows as several lines, each cut (#673) | before MCP (row 3p) |
| The base environment's `PATH` is not refreshed; the heredoc advice in the docs (plan item 615) | phase 5 |
| `baseline/security-tests.ts`: two tests renamed in phase 2 | phase 6 |
| No no-proxy list in the credential contract; the plugins take only `configure`'s `proxy` and ignore the environment's proxy variables by design (`az` inherits what the plugin passes) | the human, then a contract change |
| The test CLI hands `inputs` values to `SetValues` cast `as never`: decode them to the protocol's value type | phase 3 |
| A `runbook_test.yml` file assertion accepts an absolute or `..` path (read only, contains only, 1 MiB cap) | phase 3 |
| The WASM renderer, the new CLI's release packaging and the `runbooks-test` alias binary are not wired; SIGINT handling is untested | phases 5 and 6 |
| Windows: no process-tree kill for plugins (a job object or `taskkill /T`), no ACL check on state folders, no Windows CI | decision 15 |
| A stream whose reader stalls stalls the session until a timeout; one group kill after exit leaves a pid-reuse window; a plugin that closes its standard output and ignores stdin's close is stopped after about 10 s, and that kill isn't pinned by #636's test | before phase 6 |
| A plugin's run folder (#635): put `runDir` under userData, owned by the user, 0700, and fail closed if it isn't (a world-writable folder without the sticky bit lets another user swap the copy between close and spawn; `/tmp` may be `noexec`); sweep a crash's leftovers by owner liveness, never by age (macOS kills a program whose file goes early); retry once on `ETXTBSY` if it is ever seen. The first exec of each copy costs about 100 ms on macOS | phase 3, when `runDir` is wired |
| The plugin-binary lint misses a name built without `runbooks-` in one string | if it matters |
| An unknown error kind's raw name, and `values` detection-source values, are not scanned for secrets | phase 3 |
| A bad `RUNBOOKS_OUTPUT` gives `Invalid value for flag --output: "config". Expected: SchemaError(...)`: it names neither the value given nor the variable, and says "flag" though none was given (runbooks-reviewer on #627) | phase 3, with the CLI's help and errors |
| From group 9 (#632 to #634): in block views, `window.` and `self.` get around `no-restricted-globals`; the import ban names `bun`, `bun:sqlite`, `bun:ffi`, not `bun:*`; the graph test covers `block.ts` only, treats npm packages as leaves and takes each alias's first target; `fs.readdir` still lists a folder whole; a walk that stops when its reader stops is untested; `unbornBranchName` has no caller | if they matter |
| `GitCliClient` (a layer) builds git's environment from `process.env`, while the core's git reads `Environment`: make it depend on `Environment` (runbooks-reviewer on #632) | phase 3, when `Environment` is wired |
| `NodeFileSystem.walk`: a file removed between `readdir` and `lstat` fails the whole walk, untested (runbooks-reviewer on #634) | before phase 6 |
| The CLI tests' own temp folder (#631): `expect(os.tmpdir()).toBe(runsTemp)` in `beforeEach` would make the Windows gap fail loudly | with Windows CI (decision 15) |
| `literalOnly` (#640): the `style` prop is allowed, so a fixed full-window `div` could still cover the trust banner (inferred: jsdom has no layout); `<fencedframe>` and `<portal>` are not refused; the old tree's `src/remarkLiteralOnly.ts` has the same gaps | phase 3, with the tree walker; the old tree in phase 6 |
| The contract suite's refresh case (#641) needs an `account.refreshable` scenario: only aws can give one, a `profile` sign-in whose role has `duration_seconds = 900` (about a 10-minute wait, a real account). The suite should say so when a scenario gives `account.refreshable` and the first `env` has no `expiresAt` | the lock PR (row 98) |
| `runbooks/no-throw-in-blocks` (#642) doesn't name `JSON.parse`, `new URL(…)` or `decodeURIComponent`, and a block can still call a core helper that throws | if it matters |
| Dev mode is not wired to `fakeCredentialProviders`; `just dev` does not fetch plugins; nothing reads the shipped `plugins.lock` | phase 3 |
| Bump `resources/plugins.lock` to the plugins release that sends `envValue.file` | track A, when released |
| Real Developer ID signing and notarization with `mac.signIgnore` | the first release run |
| A large org's target list can pass the 1 MiB line cap (the plugins answer `internal`): page `targets` | a later contract change |
| Inferred from that review: the second Ctrl-C or SIGTERM (reproduced, fixed in #643) and `valueLength` over `MAX_ARG_STRLEN` (reproduced, fixed in #644). Run files 0644 in tmpdir was not reproduced: the run folder is 0700. `agentAccess`/`confirmAgentRuns` not read stays the gate before MCP | row 3o |
| `runbooks test` (#643): SIGHUP isn't handled; `validate` prints "Stopped at once" on Ctrl-C though it runs no script; a child whose `error` event fires after it spawned stays in the spawner's kill set (the pid-reuse window) | if it matters |
| The app's quit: the spawner's exit hook SIGKILLs a stopped script's group at once, and Electron doesn't wait for ref'd timers, so the quit should wait for the stops' grace or say it can't (runbooks-reviewer on #643) | row 3e |
| The environment bound (#644): Windows' 32767-character limit on one variable isn't enforced; on Linux with a stack limit under about 4 MiB the real total is below 983040 bytes; `sizeProblem`'s doc comment breaks after "`totalBytes`. The" | if it matters; the comment at the next touch of env.ts |
| `instruction` unwraps no value only by its doc comment (#645). When a second block has an `instruction`, a test runs every registry block's `instruction` with a fake secret in `values` and looks for it in the result (runbooks-reviewer). Instruction mode's first caller (#665) has only Command, whose block test checks a fake secret | the next task or credential block (rows 3j, 3m) |
| Untested in #664, each a mutant that passes every test (runbooks-reviewer): a block folding again each time it is done after the person opened it; a link into a misconfigured block's children (`framedIn`); the re-reads on `ApprovalRequested`, `ApprovalResolved`, `CredentialChanged` and `FilesChanged` | the first view that shows each (rows 3m, 3o); the folding and link tests when either is touched |
| runbooks-reviewer's re-review of row 3h, non-blocking: app.tsx's leftover "What a defect the engine sent says" doc comment sits on `ask`'s own (delete it); instruction mode letting `ActOnCredential` or `CancelBlock` through passes every test (add a case to the guard's test); swallowing an interrupt in follow's or ask's `catchCause` passes every test (harmless: nothing reads the store after unmount) | the next touch of each |
| Decision 14's `main` PRs, non-blocking (runbooks-reviewer): #668's handler passing `interval: undefined` for slow_down passes every test (no electron test sends slow_down through the handler); a `refused` OAuth code reaches the person raw, as before; #669's `isMine` keeps a now-redundant `isCurrent()` | the next touch of github.ts's poll handler |
| A form's, a task-with-a-form's or a credential block's view gets no props (#646 Decision 1: they can hold a secret default). A block whose view needs a prop needs a contract addition naming the props a view may get | phase 4, the first such block (DirPicker) |
| `DocumentView` (#646): `validate` reports only the parser's errors, not those found at open; `FieldView` has each field's section but not `FormSpec.sections`' order; `SessionView.warnings` repeats `DocumentView.warnings`; props typed `Codec<P, Schema.Json>` would move the JSON check to the build | rows 3g, 3k; the rest if it matters |
| `boilerplate.yml` readers (`config.ts:388`, `warmEligibility.ts:95`) move to `yamlData` | phase 4, Template |
| `openFileTail.finish()` reads what is left of a log file in one go when the child ends (#594) | before phase 6 |
| No saved session keeps `BlockView.files` (#602) | phase 5, the files panel |
| Template and TemplateInline report their files as `File` events, so `files_generated` counts them | phase 4, Template |
| Old-tree CI flakes: `GitAuth.switch` Reload (a stale-effect race), and `SessionName.test.tsx`'s refused-name check (#603's first run; on #636, run 45791836449, `aria-invalid` true; `GitAuth.switch` again on #645, run 45820711300) | before phase 6, or with the old tree's deletion |
| No size cap on the runbook file: `loadRunbook` reads it whole. `parseMdx` (the MDX library) is quadratic on an expression attribute that holds many braces: 8k references in one `env`, about 150 KB, took 9 s, so a 1 MiB cap like named files' would still allow about 8 minutes at open. The cap has to bound one expression attribute, or the file, much tighter. `envNameConflicts` is O(blocks × edges), and one `dependsOn` naming n blocks grows faster than linear (#638 Gaps, runbooks-reviewer) | with the bounds (row 97) |
| Opening a 3200-block runbook takes 42 to 57 times a 200-block one (16 times the blocks), even with #608: something in open or parse grows faster than linear past about 800 blocks. Not investigated | with the bounds (row 97) |
| `if hasKey` stays refused in `env` (runbooks-reviewer). GitClone's optional output: the block always gives it, empty when it doesn't apply, and a script tests `[ -n "$X" ]` | phase 4, GitClone |
| Check must declare `scripts`, so its script makes no edges | phase 4, Check |
| A sessions database that can't be used (damaged, foreign, newer) is only an `Effect.logWarning`; the person must see it, as settings' `problems` | phase 3, when the database is wired |
| A tab indent reads as UNEXPECTED_TOKEN's reason (#646, runbooks-reviewer): say tabs in that reason at the next touch | `yamlData.ts` |
| `metadataElements`' doc comment (#640) says `<base>` hands the window another document to load; it moves where every relative URL in the window resolves (runbooks-reviewer) | baseline/behaviour-changes.ts, at the next touch |
| `app-main` and `app-renderer` (#648): no lint keeps SDK or Node I/O imports out of the renderer beyond its `types: []`; Linux sandbox evidence is the renderer's seccomp mode | if it matters |
| Not pinned yet (#648, runbooks-reviewer): main's refusal of a client certificate | the first block that makes a network request from the window |
| Not pinned yet (#648, runbooks-reviewer): `ELECTRON_RENDERER_URL` honoured only unpackaged | the packaging row's e2e, on a packaged build |
| The IPC transport (#649): an error page commits no `did-navigate`, so the old connection lives until the next load; after a flood the page's client hangs until a reload, as nothing tells it the connection ended; subframe and `<webview>` senders are unit-tested only | if it matters |
| Quitting (#649): SIGINT and SIGTERM to main are unhandled; a second quit during the wait doesn't force; the 10-second cap is untested. (Command's folders now outlast a stopped script, #674.) | if it matters |
| Session folders build up under `<userData>/v0/sessions/dirs` (#649) | row 3n's retention |
| The renderer bundle is 1.28 MB with effect RPC and the protocol's schemas (#649), and grew with the walk and Tailwind (#650, not measured) | if it matters |
| Two stores on one settings file, as two Runbooks, can lose one's change: each writes back what it holds (#625 Gaps) | if a second writer becomes real |
| The login shell's environment (the old app's `populateShellEnv`) isn't read: main passes its own process environment to the engine (#649 review) | before packaging |
| The page's queue is bounded in messages (1024 of up to 1 MiB), not in characters; nothing checks at the type level that `EngineBridge` matches the preload's bridge (#649 review) | if it matters |
| A launch that can't open its runbook says so only on main's stderr, and the window shows the welcome screen; a second launch focuses the first window and doesn't open its runbook (#650) | a protocol change that tells the window; the second launch is row 3g3 |
| A second launch's runbook that fails to open is reported only on the first app's stderr; the second exits 0. After a second launch the window can't return to the earlier session, which stays open in the engine. While it clones, the window says "Asking the engine.", not "Cloning…". Connecting over http waits on the system's connect timeout (75 s on macOS); plink gets no stall options (#660). A reload during the page's first load may log `ERR_ABORTED` (#660) | the window's session switcher, with the launch-failure protocol change |
| Decision 15 ruled Windows supported (2026-11-26): a Windows CI job for the engine, the blocks and the e2e; how a script runs on Windows (bash from Git for Windows, or PowerShell, per block); case-insensitive environment names; a signed Windows build; the plugin binaries already ship windows-amd64 | phases 4 to 6 |
| No CI job runs the credential contract suite against the released plugin binaries; it was run on darwin-arm64 by hand (#656). No release builds a Linux arm64 app for the `linux-arm64` pins | track A |
| The welcome screen names a `runbooks` command, which doesn't launch the rebuilt app; task-list checkboxes show their state and aren't saved; light theme only; dev mode logs "reading 'onMessage'" once, unexplained (#650) | the packaging row; if it matters; row 3h |
| A link swapped in between the path guard's check and the read is followed, as in the old app; each asset answer holds its file open until read or cancelled, and nothing caps how many; `<source type>` is dropped; on macOS `./ASSETS/` names the folder but stays text (#651) | if it matters |
| Form values nest (lists and maps, from YAML or a prop), and nothing bounds their depth as #653 bounds the tree's | row 3k1a (#698) |
| A tree too deep for the MDX parser itself (about 10000 levels under Bun) is `syntax` with RangeError's reason at 1:1, not `tooDeep` (#653) | if it matters |
| The trust prompt's button stays enabled while it asks: an `asking` flag in `Trusting` should disable it; a block's title, author text, should be quoted in the prompt (#671 review) | with the next trust change |
| A stop holds the session lock for up to its 5 s grace: RunBlock, SetValues, ConfirmValues and ActOnCredential wait; the block shows Running and offers Cancel, and a second Cancel says "It wasn't running, so nothing was cancelled." A "Stopping" state, with the lock released during the stop (#674) | before MCP (row 3p) |
| The window doesn't draw `BlockView.files`; Command's docs.mdx says "click **View Outputs**", the old app's words (#675) | row 3q; phase 6 docs |
| In watch mode an edit on disk that a reload takes runs without a new look while the session is open (ruled: trust kept for the session). Writes outside the protocol, such as an agent's file edits, are then guarded only by agent run confirmation | row 3o |
| Row 3j2's gaps: a named folder that grows past 2000 entries after open stays watched whole; a save between a reload's read and the new watch is missed; a named file that becomes a folder isn't watched inside until a reload; approvals will count as `Running`; a credential block whose props changed shows Idle, Running, Done across two updates; hunk line numbers start at 1 on an empty side; the fake watch matches chokidar's `depth` and `ignoreInitial` by assertion, with no test against chokidar | rows 3j2e to 3j2; phase 6 |
| Resume keeps runs only when the whole runbook hash matches, while a reload keeps them per block (#684): align resume with the reload's keep rule | phase 3 or 4 |
| `docs/src/content/docs/security/execution-model.md` describes the old app's watch mode | row 3j2 or phase 6 docs |
| Invariant `Effect.die`s in session.ts (`envFrom`, ready while untrusted) and four in credentials.ts don't say they are bugs in Runbooks, as `parseHeld`'s does (#685) | phase 6 |
| The CLI and MCP open sessions with watch `off`; neither has a flag for a watch mode | row 3p |
| The rebuild's renderer tests are static markup, so nothing clicks: the trust button's and "Reload script"'s click wiring (#692 mutant R20) is covered only by e2e, and a frame keeps its last answer line (`said`) across a reload that starts its block over, so a stale "Refused…" can show; clear it when the status goes back to Idle (#690, #692 reviews). An interaction harness would test both | before row 3q |
| Command's `instruction` holds the whole held script, and `viewOf` puts it on every `GetBlock`, so a `path` Command sends up to 1 MiB per read with instruction mode off (#692) | row 3j2j or phase 4 |
| The page's `.unwatched` and `.reload-held` notes have no CSS (#690) | row 3q |
| `launch.spec.ts:201` failed to launch Electron on CI with "Missing X server or $DISPLAY" (#688, run 46044943484 attempt 1); attempt 2 passed | if it recurs |
| `loadRunbook` reads runbook.mdx whole (`fs.readFile` in `packages/core/src/document/load.ts`), with no limit, while every file a block names is capped at 1 MiB. A cap on the runbook itself would refuse runbooks the old app opens, so it is a behaviour change for the human to rule on (found in row 3j2i's review) | the human decides |
| The window's script-file store says it drops what it read once a block's last source view closes, and nothing tests it (#696 review): a reopen should show "Reading the script." before its read lands, or the claim goes | with the next change to `scriptFiles.ts` |
| bun's `expect(fn).toThrow()` passes when `fn` returns an Error, and a decoded TaggedError is one (row 3j2i; no other case found) | a lint or a test helper, if it recurs |
| A CI job for the credential contract's `[account]` cases on ephemeral OIDC credentials (ruled 2026-11-27): no long-lived secrets; it fails if no `[account]` case registers; never on a fork's PR; each cloud role trusts only this repo's workflow. The cloud side (an AWS role, a GCP workload identity pool, an Azure federated credential) is the human's; which credential shape each plugin takes from an OIDC exchange is asked of runbooks-plugins | after the supervised run |
| A sensitive field has no per-field Reset, since the window never holds its default (row 3k's plan, D9) | with 3k6, if wanted |
| Row 3m's fix for #665 (instruction text steps) takes 3k1b's path: `markdownTree` in the core, a `TreeNode` in the protocol | row 3m |
| An MCP client gets a field's description as a `TreeNode` (3k1b), so the 3p adapter decides how an agent sees it | row 3p |
| A task's own form answers `RunBlock` with `Submitted`, which it is, where a display block gets `WrongClass` (#700) | row 3p, if an agent needs the difference |
