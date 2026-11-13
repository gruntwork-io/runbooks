import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { render, screen } from "@testing-library/react"
import { SimulationBar } from "../SimulationBar"
import { SimulationContext } from "@/contexts/SimulationContext.types"
import type { SimulationState } from "../../../../../electron/shared/channels.ts"

const renderBar = (state: SimulationState) =>
  render(
    createElement(
      SimulationContext.Provider,
      { value: { state, setScenario: () => {}, revision: 0 } },
      createElement(SimulationBar),
    ),
  )

const scenarios = [{ name: "happy-path", label: "Happy path" }]

describe("SimulationBar", () => {
  it("names the scripts the scenario answers that no block on the page has", () => {
    renderBar({
      enabled: true,
      scenarios,
      active: "happy-path",
      scripts: ["set_setings"],
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
})
