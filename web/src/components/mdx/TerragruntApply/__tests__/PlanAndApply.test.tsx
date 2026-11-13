import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { PlanAndApply } from "../components/PlanAndApply"
import type { RunPhase } from "../runMachine"

const RESOURCE = {
  address: "google_cloud_identity_group.group",
  type: "google_cloud_identity_group",
  name: "group",
  properties: {},
}
const PLAN = { resources: [{ ...RESOURCE, action: "create" as const }] }

function renderPhase(phase: RunPhase) {
  return render(
    <PlanAndApply
      blockId="apply-group"
      state={{ phase, log: [] }}
      status={phase.kind === "applied" ? "current" : "ready"}
      outputs={[]}
      preflight={<p>Preflight passed: 2 checks.</p>}
      holding={false}
      onPlan={() => {}}
      onApply={() => {}}
      onCancel={() => {}}
    />,
  )
}

describe("PlanAndApply", () => {
  it("shows the steps and the preflight while a run is under way", () => {
    renderPhase({ kind: "planned", inputs: "{}", plan: PLAN })
    expect(screen.getByRole("list", { name: "Steps" })).toBeInTheDocument()
    expect(screen.getByText("Preflight passed: 2 checks.")).toBeInTheDocument()
  })

  it("shows a stop under way until the run ends, with no second Stop", () => {
    renderPhase({
      kind: "applying",
      inputs: "{}",
      plan: PLAN,
      progress: {},
      step: "apply",
      stopping: true,
    })
    expect(screen.getByRole("button", { name: /Stopping/ })).toBeDisabled()
  })

  it("says it applied in one line, without the steps, the preflight or a mark on each resource", () => {
    renderPhase({
      kind: "applied",
      inputs: "{}",
      plan: PLAN,
      result: { resources: [RESOURCE], outputs: [] },
    })
    expect(screen.getByText(/Applied\. 1 resource in the state\./)).toBeInTheDocument()
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull()
    expect(screen.queryByText("Preflight passed: 2 checks.")).toBeNull()
    expect(screen.queryByLabelText("Done")).toBeNull()
  })
})
