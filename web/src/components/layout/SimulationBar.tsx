import { FlaskConical, RefreshCw } from "lucide-react"
import { useSimulation } from "@/contexts/useSimulation"
import { usePageBlocks } from "@/contexts/ComponentIdRegistry"

/**
 * Marks a simulated run, so nobody mistakes its answers for real ones, and
 * switches between the scenarios in the runbook's simulation.yml.
 */
export function SimulationBar() {
  const { state, setScenario } = useSimulation()
  const page = usePageBlocks()
  if (!state.enabled) return null
  const active = state.scenarios.find((s) => s.name === state.active)
  const runsReal = state.answers?.runUnanswered === true
  // A misspelled unit key leaves its block to run for real, so name any no block has.
  const units = new Set(page.blocksOf("TerragruntApply").map((block) => block.id))
  const unmatchedUnits = page.registered
    ? (state.answers?.units ?? []).filter((id) => !units.has(id))
    : []

  return (
    <div
      data-testid="simulation-bar"
      className={`mb-4 rounded-lg border border-dashed px-4 py-3 text-sm ${
        runsReal ? "border-destructive/60 bg-destructive/10" : "border-warning/40 bg-warning-muted"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <FlaskConical className="size-4 text-warning" aria-hidden />
        <span className="font-semibold text-foreground">Simulation</span>
        {state.answers?.runUnanswered ? (
          <span className="text-foreground">
            Only what this scenario answers in simulation.yml is simulated. Every other step reads
            and changes real systems.
          </span>
        ) : (
          <span className="text-muted-foreground">
            Lookups, checks, Terragrunt runs and the scripts the scenario names answer from
            simulation.yml. GitHub and GitLab sign-ins and clones are real, since they only read.
            Anything else that would reach a real system, such as another script, a push or a pull
            request, is refused.
          </span>
        )}
        {state.scenarios.length > 0 && (
          <label className="ml-auto flex items-center gap-2">
            <span className="text-muted-foreground">Scenario</span>
            <select
              aria-label="Simulation scenario"
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={state.active ?? ""}
              onChange={(e) => setScenario(e.target.value)}
            >
              {state.active === undefined && (
                <option value="" disabled>
                  Pick a scenario
                </option>
              )}
              {state.scenarios.map((scenario) => (
                <option key={scenario.name} value={scenario.name}>
                  {scenario.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              title="Read simulation.yml again"
              aria-label="Read simulation.yml again"
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              onClick={() => setScenario(state.active ?? "")}
            >
              <RefreshCw className="size-3.5" />
            </button>
          </label>
        )}
      </div>
      {active?.description && <p className="mt-1 text-muted-foreground">{active.description}</p>}
      {unmatchedUnits.length > 0 && (
        <p className="mt-1 text-destructive">
          The scenario answers units no TerragruntApply block on this page has:{" "}
          {unmatchedUnits.join(", ")}. Check each id against the runbook.
        </p>
      )}
      {state.unmatchedScripts && state.unmatchedScripts.length > 0 && (
        <p className="mt-1 text-destructive">
          The scenario answers scripts no block on this page has:{" "}
          {state.unmatchedScripts.join(", ")}. Check each id against the runbook.
        </p>
      )}
      {state.error && <p className="mt-1 text-destructive">{state.error}</p>}
    </div>
  )
}
