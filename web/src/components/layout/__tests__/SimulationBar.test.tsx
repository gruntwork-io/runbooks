import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { render, screen } from "@testing-library/react"
import { SimulationBar } from "../SimulationBar"
import { SimulationContext } from "@/contexts/SimulationContext.types"
import { ComponentIdRegistryProvider, useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import type { SimulationAnswers } from "../../../../../src/domain/simulation/answers.ts"
import type { SimulationState } from "../../../../../electron/shared/channels.ts"

/** A TerragruntApply block on the page, as far as the bar can tell. */
function UnitBlock({ id }: { id: string }) {
  useComponentIdRegistry(id, "TerragruntApply")
  return null
}

const renderBar = (state: SimulationState, unitBlocks: string[] = []) =>
  render(
    createElement(
      ComponentIdRegistryProvider,
      null,
      createElement(
        SimulationContext.Provider,
        { value: { state, setScenario: () => {}, revision: 0 } },
        createElement(SimulationBar),
        ...unitBlocks.map((id) => createElement(UnitBlock, { key: id, id })),
      ),
    ),
  )

const scenarios = [{ name: "happy-path", label: "Happy path" }]
const answers = (more: Partial<SimulationAnswers>): SimulationAnswers => ({
  runUnanswered: false,
  units: [],
  responses: [],
  scripts: [],
  ...more,
})

describe("SimulationBar", () => {
  it("names the scripts the scenario answers that no block on the page has", () => {
    renderBar({
      enabled: true,
      scenarios,
      active: "happy-path",
      answers: answers({ scripts: ["set_setings"] }),
      unmatchedScripts: ["set_setings"],
    })
    expect(screen.getByTestId("simulation-bar")).toHaveTextContent(
      "The scenario answers scripts no block on this page has: set_setings.",
    )
  })

  it("says nothing about scripts when every one matches a block", () => {
    renderBar({ enabled: true, scenarios, active: "happy-path", unmatchedScripts: [] })
    expect(screen.getByTestId("simulation-bar")).not.toHaveTextContent("no block on this page")
  })

  it("names the units the scenario answers that no TerragruntApply block on the page has", async () => {
    renderBar(
      {
        enabled: true,
        scenarios,
        active: "happy-path",
        answers: answers({ runUnanswered: true, units: ["apply-account", "aply-budget"] }),
      },
      ["apply-account", "apply-budget"],
    )
    expect(
      await screen.findByText(/units no TerragruntApply block on this page has: aply-budget\./),
    ).toBeInTheDocument()
  })

  it("says every step it doesn't answer is real when the scenario runs them for real", () => {
    renderBar({
      enabled: true,
      scenarios,
      active: "happy-path",
      answers: answers({ runUnanswered: true }),
    })
    expect(screen.getByTestId("simulation-bar")).toHaveTextContent(
      "Every other step reads and changes real systems.",
    )
  })

  it("asks for a scenario when none is picked", () => {
    renderBar({ enabled: true, scenarios, error: "Pick one in the Simulation bar to start." })
    expect(screen.getByRole("option", { name: "Pick a scenario" })).toBeInTheDocument()
  })
})
