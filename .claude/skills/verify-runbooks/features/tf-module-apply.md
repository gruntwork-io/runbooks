# The TfModule Apply tab

The Apply tab runs Terragrunt for the block: a plan whose resources open to show their properties, then an apply that shows each resource as it's made, and the module's outputs. In simulation mode `simulation.yml` answers instead of Terragrunt.

## Sub-features

- Plan, with Stop while it runs; a step rail (Init, Plan, Apply, Outputs).
- The plan's resources with their actions; a property filter, Only known, Table or Plan text layouts.
- Apply, with Stop, each resource's progress, and the outputs (links, copy buttons, sensitive values hidden).
- A plan with nothing to change counts as applied.
- Stale: the inputs changed since the plan or the apply, so it asks to plan again.
- Stopped: a stopped plan says nothing changed; a stopped apply shows what it finished.
- Failed: the error, what the apply did before it, and Plan again (scenario `apply-fails`).

## How to get to it (user POV)

Click the Apply tab, or follow the Next and next-step buttons from the Code and PR tabs.

## Driving it with control-runbooks

1. `$C setup group-form`, `$C click tab:Apply --within group`. Check: an explanation and Plan.
2. `$C click button:Plan --exact --within group`, `$C wait button:Apply --exact --within group`. Check: "Plan: 2 to create", the group and the owner's membership.
3. `$C click button:Apply --exact --within group`, `$C wait --text "Applied." --within group`. Check: both resources done, outputs with "View the Google Group" and the group email.
4. Change Name on the UI tab, back to Apply. Check: a warning that the inputs changed since this apply, and Plan; the old outputs are marked as the old ones.
5. Stop: `$C click button:Plan --exact --within group --settle 150`, then `$C click button:Stop --within group`. Check: "You stopped the plan. Nothing changed." in warning colors, not as a failure.
6. Failure: `$C setup scenario apply-fails`, plan, apply. Check: "What the apply did before it failed", the group done and the membership failed, the 403 error, and Plan again.

Proof: the outputs reach other blocks (`{{ .outputs.group.runbooks_console_url }}` in the runbook text renders the link), and the block's progress check turns done once it's applied and merged.

Automated tests: `__tests__/runMachine.test.ts` (phases, stale, stopped, no-change plans), `src/domain/tf-module/run.test.ts` (reading OpenTofu's JSON), `src/domain/tf-module/simulation.test.ts`.

## Gotchas

- Without `--simulate`, Terragrunt must be on PATH and Apply changes real infrastructure; dry-run first.
- The simulation's `delayMs` makes each step take about 700ms; `wait` before the next click.
- The main process applies only the saved plan for the inputs as they are; an apply for other inputs fails with "Plan again".
