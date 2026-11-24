import { describe, it, expect } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ViewPlan } from "../ViewPlan"
import type { PlanCounts, PlanSummary, PlanUnit } from "@/lib/planSummary"

const counts = (c: Partial<PlanCounts> = {}): PlanCounts => ({
  add: 0,
  change: 0,
  destroy: 0,
  replace: 0,
  import: 0,
  forget: 0,
  move: 0,
  ...c,
})

const unit = (u: Partial<PlanUnit> & { name: string }): PlanUnit => ({
  planned: true,
  counts: counts(),
  resources: [],
  outputs: [],
  ...u,
})

const PLAN: PlanSummary = {
  totals: counts({ add: 1, change: 1, destroy: 1 }),
  units: [
    unit({
      name: "subscriptions/dev",
      counts: counts({ change: 1, destroy: 1 }),
      resources: [
        { address: "azurerm_role_assignment.legacy", action: "delete", attributes: [] },
        {
          address: "azurerm_role_definition.pipelines",
          action: "update",
          attributes: [
            { path: "permissions[0].actions[1]", after: '"Microsoft.Authorization/write"' },
            { path: "client_secret", sensitive: true },
          ],
        },
      ],
    }),
    unit({ name: "subscriptions/prod" }),
    unit({ name: "subscriptions/qa", planned: false, result: "failed", reason: "run error" }),
  ],
}

describe("ViewPlan", () => {
  it("renders nothing without a plan", () => {
    const { container } = render(<ViewPlan plan={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("sums up the changes and calls out destroys", () => {
    render(<ViewPlan plan={PLAN} />)
    const header = screen.getByRole("button", { name: /View Plan/ })
    expect(header).toHaveTextContent("+1")
    expect(header).toHaveTextContent("~1")
    expect(header).toHaveTextContent("-1")
    expect(header).toHaveTextContent("3 units")
    expect(header).toHaveTextContent("1 to destroy or replace")
  })

  it("lists each unit's changes, and the units without any on one line", () => {
    render(<ViewPlan plan={PLAN} />)
    expect(screen.getByText("azurerm_role_assignment.legacy")).toBeInTheDocument()
    expect(screen.getByText("destroy")).toBeInTheDocument()
    expect(screen.getByText(/No changes in 1 unit/)).toHaveTextContent("subscriptions/prod")
  })

  it("shows a unit that failed before it planned, with why", () => {
    render(<ViewPlan plan={PLAN} />)
    const qa = screen.getByRole("button", { name: /subscriptions\/qa/ })
    expect(within(qa).getByText("failed")).toBeInTheDocument()
    expect(screen.getByText("run error")).toBeInTheDocument()
  })

  it("opens a resource to show its attribute changes, with sensitive values hidden", async () => {
    render(<ViewPlan plan={PLAN} />)
    await userEvent.click(screen.getByRole("button", { name: /azurerm_role_definition.pipelines/ }))
    expect(screen.getByText("permissions[0].actions[1]")).toBeInTheDocument()
    expect(screen.getByText('"Microsoft.Authorization/write"')).toBeInTheDocument()
    expect(screen.getByText("(sensitive value)")).toBeInTheDocument()
  })

  it("doesn't make a destroy, which lists no attributes, openable", () => {
    render(<ViewPlan plan={PLAN} />)
    expect(screen.getByRole("button", { name: /azurerm_role_assignment.legacy/ })).toBeDisabled()
  })
})
