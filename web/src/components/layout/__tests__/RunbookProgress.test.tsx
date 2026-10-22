import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { RunbookProgressProvider } from "@/contexts/RunbookProgressContext"
import { ThemeProvider } from "@/contexts/ThemeContext"
import { ProgressStep } from "@/components/mdx/_shared/components/ProgressStep"
import { Header } from "../Header"
import { RunbookProgressBar, RunbookProgressCount } from "../RunbookProgress"

// The header's menu downloads every block's logs; none are needed here.
vi.mock("@/hooks/useDownloadLogs", () => ({
  useDownloadLogs: () => ({ hasLogs: false, downloadRaw: vi.fn(), downloadJson: vi.fn() }),
}))

type Api = Parameters<typeof ApiProvider>[0]["api"]
const api = { invoke: vi.fn(async () => undefined), on: () => () => {} } as unknown as Api

/** The header of an open runbook whose steps are done or not, as `steps` says. */
function renderHeader(steps: boolean[]) {
  return render(
    <ApiProvider api={api}>
      <ThemeProvider>
        <RunbookProgressProvider>
          <Header
            sessionName="elegant-elephant"
            onSessionRenamed={vi.fn()}
            onOpenCommandPalette={vi.fn()}
            onOpenSessions={vi.fn()}
            onCloseRunbook={vi.fn()}
          />
          {steps.map((done, i) => (
            <ProgressStep key={i} done={done} />
          ))}
        </RunbookProgressProvider>
      </ThemeProvider>
    </ApiProvider>,
  )
}

describe("RunbookProgressCount", () => {
  it("says how many of the steps are done", () => {
    render(<RunbookProgressCount progress={{ total: 5, done: 2 }} />)
    expect(screen.getByTestId("runbook-progress-count")).toHaveTextContent("2 of 5 steps done")
    expect(screen.getByTestId("runbook-progress-count")).not.toHaveClass("text-success")
  })

  it("says step, not steps, for a runbook with one", () => {
    render(<RunbookProgressCount progress={{ total: 1, done: 0 }} />)
    expect(screen.getByTestId("runbook-progress-count")).toHaveTextContent("0 of 1 step done")
  })

  it("turns green once every step is done", () => {
    render(<RunbookProgressCount progress={{ total: 3, done: 3 }} />)
    expect(screen.getByTestId("runbook-progress-count")).toHaveTextContent("3 of 3 steps done")
    expect(screen.getByTestId("runbook-progress-count")).toHaveClass("text-success")
  })
})

describe("RunbookProgressBar", () => {
  it("is a progress bar that says how many steps are done", () => {
    render(<RunbookProgressBar progress={{ total: 5, done: 2 }} />)
    const bar = screen.getByRole("progressbar", { name: "Runbook progress" })
    expect(bar).toHaveAttribute("aria-valuemin", "0")
    expect(bar).toHaveAttribute("aria-valuemax", "5")
    expect(bar).toHaveAttribute("aria-valuenow", "2")
    expect(bar).toHaveAttribute("aria-valuetext", "2 of 5 steps done")
  })

  it("fills in proportion to the steps done", () => {
    render(<RunbookProgressBar progress={{ total: 5, done: 2 }} />)
    const fill = screen.getByRole("progressbar").firstElementChild
    expect(fill).toHaveStyle({ width: "40%" })
  })
})

describe("Header progress", () => {
  it("shows no progress for a runbook without steps", () => {
    renderHeader([])
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.queryByTestId("runbook-progress-count")).toBeNull()
  })

  it("shows the runbook's progress as a count and a bar", () => {
    renderHeader([true, false, true, false])
    expect(screen.getByTestId("runbook-progress-count")).toHaveTextContent("2 of 4 steps done")
    expect(screen.getByRole("progressbar", { name: "Runbook progress" })).toHaveAttribute(
      "aria-valuenow",
      "2",
    )
  })
})
