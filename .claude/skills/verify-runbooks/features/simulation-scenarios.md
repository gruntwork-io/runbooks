# Simulation scenarios

A runbook opened with `--simulate` answers lookups, plans, applies, and pull requests from its `simulation.yml`. The simulation bar at the top marks the run as simulated and switches between the file's scenarios.

## Sub-features

- The bar: "Simulation", what it means, the Scenario picker, and the active scenario's description.
- Switching scenarios: lookups and runs answer from the new one right away.
- Read simulation.yml again: picks up edits to the file without reopening the runbook.
- An invalid simulation.yml: the bar shows the error.

## How to get to it (user POV)

`runbooks open --simulate <runbook>`; the bar is above the runbook.

## Driving it with control-runbooks

1. `$C up testdata/feature-demos/tf-module --simulate`, `$C snapshot`. Check: the bar, combobox "Simulation scenario" with Happy path selected, and its description.
2. `$C setup scenario group-exists`. Check: the description changes to the group-exists one.
3. `$C setup group-form`, open the Code tab. Check: the unit's terragrunt.hcl is marked changed, which only that scenario's repository makes true.
4. Edit `testdata/feature-demos/tf-module/simulation.yml` (say, a scenario description), `$C click "button:Read simulation.yml again"`. Check: the new text shows. Undo the edit afterward.

Proof: a block's answers follow the active scenario without reopening the runbook.

Automated tests: `src/domain/tf-module/simulation.test.ts`, `electron/main/ipc/simulation.ts`'s tests where they exist.

## Gotchas

- Block state (plans, pull requests) stays when the scenario changes; for a clean journey, `down` and `up` again.
