# The TerragruntApply block

A `<TerragruntApply>` block plans and applies one Terragrunt unit in a clone, such as the one a `<TfModule>` block generated: first a preflight (the tools, the push, and the unit's module's checks, run through the auth blocks its `auth` prop lists), then a plan whose resources open to show their properties, then an apply that shows each resource as it's made, and the unit's outputs. In simulation mode, the scenario's `units` and `responses` answer instead, with no clone, Terragrunt or sign-in.

## Sub-features

- What it runs: the unit's path and who it runs as, one line per auth block; "nobody, simulated for" in simulation.
- Preflight: "Preflight passed", or what stops the plan (missing tools, unpushed changes, a failed check with its fix link), or a check that couldn't tell, with Plan anyway.
- Plan, with Stop while it runs; a step rail (Init, Plan, Apply, Outputs).
- The plan's resources with their actions; a property filter, Only known, Table or Plan text layouts.
- Apply, with Stop, each resource's progress, and the outputs (links, copy buttons, sensitive values hidden).
- A plan with nothing to change counts as applied.
- Stale: the unit's path changed since the plan or the apply, so it asks to plan again.
- Stopped: a stopped plan says nothing changed; a stopped apply shows what it finished.
- Failed: the error, what the apply did before it, and Plan again (scenario `apply-fails`).

## How to get to it (user POV)

Fill the `<TfModule>` form and press Generate; the `apply-group` block below it waits for the code's path until then.

## Driving it with control-runbooks

1. `$C setup group-code`, `$C snapshot --within apply-group`. Check: the unit google-groups/platform@example.com, "nobody, simulated for workspace", and Plan.
2. `$C click button:Plan --exact --within apply-group`, `$C wait button:Apply --exact --within apply-group`. Check: "Preflight passed", then the plan with the group and the owner's membership.
3. `$C click button:Apply --exact --within apply-group`, `$C wait --text "Applied." --within apply-group`. Check: both resources done, outputs with "View the Google Group" and the group email.
4. Stop: `$C click button:Plan --exact --within apply-group --settle 150`, then `$C click button:Stop --within apply-group`. Check: "You stopped the plan. Nothing changed." in warning colors, not as a failure.
5. Failed check: `$C setup scenario api-off`, Plan. Check: "cloudidentity.googleapis.com is off in simulated-project." with its fix link, and no plan.
6. Failed apply: `$C setup scenario apply-fails`, plan, apply. Check: "What the apply did before it failed", the group done and the last membership failed, the 403 error, and Plan again.
7. Existing resources: `$C setup scenario group-exists`, plan. Check: the group's update with its old and new name, and the membership being deleted.

Proof: the outputs reach other blocks (`{{ .outputs.apply_group.runbooks_console_url }}` in the runbook text renders the link), and the block's progress check turns done once it's applied.

Automated tests: `web/src/components/mdx/TerragruntApply/__tests__/` (the block, its preflight, and `runMachine.test.ts` for phases, stale, stopped, no-change plans), `src/domain/terragrunt/run.test.ts` (reading OpenTofu's JSON), `src/domain/simulation/unit.test.ts`, `electron/main/ipc/terragrunt-apply.test.ts` (push and fingerprint checks).

## Gotchas

- Without `--simulate`, Terragrunt must be on PATH, the auth blocks must be signed in, and Apply changes real infrastructure; dry-run first.
- The simulation's `delayMs` makes each step take about 700ms; `wait` before the next click.
- The main process applies only the plan it saved, and only while the unit's files are as they were; anything else fails with "Plan again".
