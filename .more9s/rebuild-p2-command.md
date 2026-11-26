# Phase 2 last PRs: Command definition + driver, exit evidence (not committed; not pushed)

Goal: Command's definition and driver (no view) in blocks/command, one registry line; prove phase 2 exit.
Size: large, 3 PRs stacked on rebuild/p2-credential-names 70ff25fe (#581).

## Plan
| PR | Branch | What |
|---|---|---|
| 47 | rebuild/p2-task-reads | contract: TaskReads {values, outputs, files}; TaskInput extends it; instruction(p, reads) |
| 48 | rebuild/p2-script-values | core domain/exec: {{ }} references in a bash script, each a quoted expansion of a reserved variable |
| 49 | rebuild/p2-command | blocks/command/block.ts + registry + CLI ProcessSpawner + baseline binds Command; fixture test file lives in packages/cli/src/main.test.ts (frozen baseline forbids a new testdata runbook_test.yml); Done when |

## Decisions (as built)
- Fixture: neither named fixture is in baseline FIXTURES nor has runbook_test.yml. capture-files-from-scripts can't pass under rulings (export persistence, GENERATED_FILES). block-id-collisions: runbook unchanged; its test file is written by main.test.ts beside a temp copy.
- Decision 9: keep {{ }}, quote what it inserts: "${RUNBOOK_VALUE_n}" by context; value via env; refuse other actions, quoted heredoc, $'', backquotes, ${...}, arithmetic, non-bash interpreters. env prop still unrendered (#539): 53 tags in 22 testdata runbooks affected; needs a ruling.
- Decision 8: outputs prop declared (string list), as Iframe.

## Status
- Done 2026-11-25. Branches: rebuild/p2-task-reads d2feda87, rebuild/p2-script-values 4132d8de, rebuild/p2-command 15403200. All six checks pass on each; Command tests 5/5; 13 mutations all caught (command-work/mutants/results*.json).
- PR bodies: scratchpad/prs/p2-command-contract.md (PR 47), p2-command-values.md (PR 48), p2-command-block.md (PR 49, Done when).
- Found, not fixed: string inputsId is badProp (phase 1 schema); runbooks test does not list errors of blocks no step names; spawner collectedLines unbounded.
