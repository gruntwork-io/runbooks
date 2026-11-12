# Simulation scenarios

A runbook opened with `--simulate` answers lookups, checks, and `<TerragruntApply>` blocks from its `simulation.yml`, falling back on the `recorded` scenario of each module's own `simulation.yml`. The simulation bar at the top marks the run as simulated and switches between the file's scenarios.

## Sub-features

- The bar: "Simulation", what it means, the Scenario picker, and the active scenario's description.
- Switching scenarios: lookups, checks and runs answer from the new one right away, including a block whose form is already filled.
- Read simulation.yml again: picks up edits to the file without reopening the runbook.
- A lookup the runbook's scenario doesn't answer answers from the module's recording.
- An invalid simulation.yml: the bar shows the error.

## How to get to it (user POV)

`runbooks open --simulate <runbook>`; the bar is above the runbook.

## Driving it with control-runbooks

1. `$C up testdata/feature-demos/tf-module --simulate`, `$C snapshot`. Check: the bar, combobox "Simulation scenario" with Happy path selected, and its description.
2. `$C setup scenario no-directory-access`. Check: the description changes to that scenario's.
3. `$C setup group-form`, then `$C type a --label Members --within group`. Check: the people lookup fails with the 403, and a typed value still works.
4. `$C setup scenario happy-path` without touching the form, type in Members again. Check: Ana, Bo and Cy are suggested.
5. Edit `testdata/feature-demos/tf-module/simulation.yml` (say, a scenario description), `$C click "button:Read simulation.yml again"`. Check: the new text shows. Undo the edit afterward.
6. Recorded fallback: `$C setup group-code`, then Plan in `apply-group`. Check: "Preflight passed", answered by the module's recorded `google.apiEnabled`, which the runbook's happy path doesn't give.

Proof: a block's answers follow the active scenario without reopening the runbook.

Automated tests: `src/domain/simulation/scenarios.test.ts`, `src/domain/simulation/unit.test.ts`, and the simulation test in `web/src/components/mdx/TerragruntApply/__tests__/TerragruntApply.test.tsx`.

## Gotchas

- Block state (plans, applies) stays when the scenario changes; for a clean journey, `down` and `up` again.
