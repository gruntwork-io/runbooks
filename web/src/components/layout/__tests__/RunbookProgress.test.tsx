import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { RunbookProgressProvider } from "@/contexts/RunbookProgressContext"
import { ThemeProvider } from "@/contexts/ThemeContext"
import { ProgressStep } from "@/components/mdx/_shared/components/ProgressStep"
import { Header } from "../Header"
import { RunbookProgressBar } from "../RunbookProgress"

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
  })

  it("shows the runbook's progress as a bar, and no count", () => {
    renderHeader([true, false, true, false])
    expect(screen.queryByText(/steps done/)).toBeNull()
    expect(screen.getByRole("progressbar", { name: "Runbook progress" })).toHaveAttribute(
      "aria-valuenow",
      "2",
    )
  })
})
