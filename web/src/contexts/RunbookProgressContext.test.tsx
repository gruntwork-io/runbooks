import { describe, it, expect } from "vitest"
import { StrictMode, useState, type ReactNode } from "react"
import { render, renderHook, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProgressStep } from "@/components/mdx/_shared/components/ProgressStep"
import { RunbookProgressProvider } from "./RunbookProgressContext"
import { useRunbookProgress } from "./useRunbookProgress"

function Progress() {
  const { done, total } = useRunbookProgress()
  return <p data-testid="progress">{`${done}/${total}`}</p>
}

/** Stands in for a block: one step, which a button marks done or not done. */
function Step({ name, initiallyDone = false }: { name: string; initiallyDone?: boolean }) {
  const [done, setDone] = useState(initiallyDone)
  return (
    <>
      <ProgressStep done={done} />
      <button type="button" onClick={() => setDone(!done)}>
        {`Toggle ${name}`}
      </button>
    </>
  )
}

/** Stands in for a block that stops counting, as one does that shows an error instead. */
function RemovableStep() {
  const [shown, setShown] = useState(true)
  return (
    <>
      {shown && <ProgressStep done />}
      <button type="button" onClick={() => setShown(false)}>
        Remove
      </button>
    </>
  )
}

function renderPage(children: ReactNode) {
  return render(
    <RunbookProgressProvider>
      {children}
      <Progress />
    </RunbookProgressProvider>,
  )
}

describe("RunbookProgressContext", () => {
  it("has no steps outside a provider", () => {
    const { result } = renderHook(() => useRunbookProgress())
    expect(result.current).toEqual({ total: 0, done: 0 })
  })

  it("has no steps on a page without any", () => {
    renderPage(<p>Just text</p>)
    expect(screen.getByTestId("progress")).toHaveTextContent("0/0")
  })

  it("counts each step, and the steps that are done", () => {
    renderPage(
      <>
        <Step name="a" initiallyDone />
        <Step name="b" />
        <Step name="c" />
      </>,
    )
    expect(screen.getByTestId("progress")).toHaveTextContent("1/3")
  })

  it("counts a step as done, and not done again, as it changes", async () => {
    const user = userEvent.setup()
    renderPage(
      <>
        <Step name="a" />
        <Step name="b" />
      </>,
    )

    await user.click(screen.getByRole("button", { name: "Toggle a" }))
    expect(screen.getByTestId("progress")).toHaveTextContent("1/2")
    await user.click(screen.getByRole("button", { name: "Toggle b" }))
    expect(screen.getByTestId("progress")).toHaveTextContent("2/2")
    await user.click(screen.getByRole("button", { name: "Toggle a" }))
    expect(screen.getByTestId("progress")).toHaveTextContent("1/2")
  })

  it("stops counting a step once it is no longer rendered", async () => {
    const user = userEvent.setup()
    renderPage(
      <>
        <RemovableStep />
        <Step name="b" />
      </>,
    )
    expect(screen.getByTestId("progress")).toHaveTextContent("1/2")

    await user.click(screen.getByRole("button", { name: "Remove" }))

    expect(screen.getByTestId("progress")).toHaveTextContent("0/1")
  })

  it("counts each step once in StrictMode, which mounts it twice", () => {
    render(
      <StrictMode>
        <RunbookProgressProvider>
          <Step name="a" initiallyDone />
          <Step name="b" />
          <Progress />
        </RunbookProgressProvider>
      </StrictMode>,
    )
    expect(screen.getByTestId("progress")).toHaveTextContent("1/2")
  })

  it("lets a step render outside a provider, counted nowhere", () => {
    const { container } = render(<ProgressStep done />)
    expect(container).toBeEmptyDOMElement()
  })
})
