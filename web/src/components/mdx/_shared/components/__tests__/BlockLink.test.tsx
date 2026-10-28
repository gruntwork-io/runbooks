import { describe, it, expect, vi, beforeEach } from "vitest"
import { useEffect, useRef } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useChaptersControl } from "@/contexts/useRunbookChapters"
import { Chapter } from "@/components/mdx/Chapter/Chapter"
import { BlockLink } from "../BlockLink"

/** Stands in for a block: registers its id and its element, as blocks do. */
function Block({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useComponentIdRegistry(id, "Command", ref)
  return <div ref={ref} data-testid={id} />
}

/** Sets the chapters, as MDXContainer does once the runbook compiles. */
function SetChapters({ titles }: { titles: string[] }) {
  const { setChapters } = useChaptersControl()
  useEffect(() => {
    setChapters(titles.map((title) => ({ title })))
  }, [titles, setChapters])
  return null
}

const CHAPTER_TITLES = ["One", "Two"]

const scrolledTo = () => vi.mocked(Element.prototype.scrollIntoView).mock.instances

describe("BlockLink", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it("scrolls to the block with the id a template refers to it by", async () => {
    const user = userEvent.setup()
    render(
      <TestWrapper>
        <Block id="create-account" />
        <BlockLink blockId="create_account" />
      </TestWrapper>,
    )

    await user.click(screen.getByRole("button", { name: "create_account" }))

    expect(scrolledTo()).toEqual([screen.getByTestId("create-account")])
  })

  it("leaves an id that no block on the page has as plain text", () => {
    render(
      <TestWrapper>
        <Block id="create-account" />
        <BlockLink blockId="missing" />
      </TestWrapper>,
    )

    expect(screen.getByText("missing")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "missing" })).toBeNull()
  })

  it("shows the hidden chapter a block is in before scrolling to it", async () => {
    const user = userEvent.setup()
    render(
      <TestWrapper>
        <SetChapters titles={CHAPTER_TITLES} />
        <Chapter title="One" chapterIndex="0">
          <BlockLink blockId="deploy" />
        </Chapter>
        <Chapter title="Two" chapterIndex="1">
          <Block id="deploy" />
        </Chapter>
      </TestWrapper>,
    )
    const block = screen.getByTestId("deploy")
    expect(block).not.toBeVisible()

    await user.click(screen.getByRole("button", { name: "deploy" }))

    expect(block).toBeVisible()
    expect(scrolledTo()).toEqual([block])
  })
})
