import { describe, it, expect } from "vitest"
import { useEffect, useState } from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RunbookProgressProbe, TestWrapper } from "@/test/test-utils"
import { ProgressStep } from "@/components/mdx/_shared/components/ProgressStep"
import { useChaptersControl } from "@/contexts/useRunbookChapters"
import { Chapter } from "../Chapter"

/** Sets the chapters, as MDXContainer does once the runbook compiles. */
function SetChapters({ titles }: { titles: string[] }) {
  const { setChapters } = useChaptersControl()
  useEffect(() => {
    setChapters(titles.map((title) => ({ title })))
  }, [titles, setChapters])
  return null
}

/** Stands in for a block: one step, which a button marks done or not done. */
function Step({ name }: { name: string }) {
  const [done, setDone] = useState(false)
  return (
    <>
      <ProgressStep done={done} />
      <button type="button" onClick={() => setDone(!done)}>
        {`${done ? "Undo" : "Do"} ${name}`}
      </button>
    </>
  )
}

const TITLES = ["One", "Two"]

function renderChapters() {
  return render(
    <TestWrapper>
      <SetChapters titles={TITLES} />
      <Chapter title="One" chapterIndex="0">
        <Step name="a" />
        <Step name="b" />
      </Chapter>
      <Chapter title="Two" chapterIndex="1">
        <Step name="c" />
      </Chapter>
      <RunbookProgressProbe />
    </TestWrapper>,
  )
}

const bar = () => screen.getByRole("navigation", { name: "Chapters" })

async function contents() {
  await userEvent.click(within(bar()).getByRole("button", { name: "Contents" }))
  const items = await screen.findAllByRole("menuitem")
  return items.map((item) => item.textContent)
}

describe("Chapter progress", () => {
  it("counts the steps in hidden chapters toward the runbook's progress", async () => {
    renderChapters()
    await waitFor(() => expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/3"))
    expect(screen.getByRole("button", { name: "Do c", hidden: true })).not.toBeVisible()
  })

  it("shows each chapter's steps in the table of contents, and marks a chapter with all of them done", async () => {
    const user = userEvent.setup()
    renderChapters()
    await user.click(await screen.findByRole("button", { name: "Do a" }))

    expect(await contents()).toEqual(["1One1/2", "2Two0/1"])
    await user.keyboard("{Escape}")

    await user.click(screen.getByRole("button", { name: "Do b" }))
    expect(await contents()).toEqual(["One2/2", "2Two0/1"])
    expect(screen.getAllByRole("menuitem")[0]).toContainElement(screen.getByLabelText("Done"))
  })

  it("keeps a hidden chapter's blocks mounted, with their state", async () => {
    const user = userEvent.setup()
    renderChapters()
    await user.click(await screen.findByRole("button", { name: "Do a" }))

    await user.click(within(bar()).getByRole("button", { name: "Next chapter: Two" }))
    expect(screen.getByRole("button", { name: "Undo a", hidden: true })).not.toBeVisible()
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("1/3")

    await user.click(within(bar()).getByRole("button", { name: "Previous chapter: One" }))
    expect(screen.getByRole("button", { name: "Undo a" })).toBeVisible()
  })
})
