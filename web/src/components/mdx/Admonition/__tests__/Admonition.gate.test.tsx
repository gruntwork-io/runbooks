import { describe, it, expect, vi, beforeEach } from "vitest"
import { useEffect } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import { SessionHistoryContext, type SessionHistory } from "@/contexts/SessionHistoryContext.types"
import { Admonition } from "../Admonition"

let ctx: RunbookContextType | undefined
function Capture() {
  const runbook = useRunbookContext()
  useEffect(() => {
    ctx = runbook
  }, [runbook])
  return null
}

let saved: Record<string, unknown> = {}
const record = vi.fn()
const history = {
  saved: (blockId: string, kind: string) => saved[`${blockId}:${kind}`],
  record,
} as unknown as SessionHistory

function renderGate(props: Partial<React.ComponentProps<typeof Admonition>> = {}) {
  return render(
    <TestWrapper>
      <SessionHistoryContext.Provider value={history}>
        <Capture />
        <Admonition
          id="mail-arrived"
          type="warning"
          title="Send a test mail"
          confirmationText="It arrived"
          {...props}
        />
      </SessionHistoryContext.Provider>
    </TestWrapper>,
  )
}

const confirmed = () => ctx?.blockOutputs.mail_arrived?.values

describe("Admonition with an id", () => {
  beforeEach(() => {
    ctx = undefined
    saved = {}
    record.mockClear()
  })

  it("sets CONFIRMED once confirmed, records it, and stays shown as confirmed", async () => {
    renderGate()
    await waitFor(() => expect(ctx).toBeDefined())
    expect(confirmed()).toBeUndefined()

    fireEvent.click(screen.getByRole("button", { name: "It arrived" }))

    await waitFor(() => expect(confirmed()).toEqual({ CONFIRMED: "true" }))
    expect(record).toHaveBeenCalledWith("mail-arrived", "confirmation", { confirmed: true })
    expect(screen.getByText("Confirmed")).toBeInTheDocument()
    expect(screen.getByText("Send a test mail")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "It arrived" })).not.toBeInTheDocument()
  })

  it("comes back confirmed when the session resumes", async () => {
    saved = { "mail-arrived:confirmation": { confirmed: true } }
    renderGate()
    await waitFor(() => expect(confirmed()).toEqual({ CONFIRMED: "true" }))
    expect(screen.getByText("Confirmed")).toBeInTheDocument()
    expect(record).not.toHaveBeenCalled()
  })

  it("needs confirmationText", () => {
    renderGate({ confirmationText: "" })
    expect(screen.getByText(/needs confirmationText/)).toBeInTheDocument()
  })

  it("can't be closed or hidden for good, which would leave it unconfirmable", () => {
    const { unmount } = renderGate({ closable: true })
    expect(screen.getByText(/can't be closable/)).toBeInTheDocument()
    unmount()
    renderGate({ allowPermanentHide: true, storageKey: "mail" })
    expect(screen.getByText(/can't use allowPermanentHide/)).toBeInTheDocument()
  })

  it("refuses an id another block has", async () => {
    render(
      <TestWrapper>
        <Admonition id="gate" type="note" confirmationText="Done" />
        <Admonition id="gate" type="note" confirmationText="Done" />
      </TestWrapper>,
    )
    expect((await screen.findAllByText(/gate/)).length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "Done" })).toHaveLength(0))
  })
})
