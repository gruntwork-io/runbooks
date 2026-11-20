import { describe, it, expect, vi, beforeEach } from "vitest"
import { useEffect } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useChaptersControl } from "@/contexts/useRunbookChapters"
import { issueAnchor, type ErrorSeverity } from "@/contexts/ErrorReportingContext.types"
import { Admonition, type AdmonitionType } from "@/components/mdx/Admonition/Admonition"
import { Chapter } from "@/components/mdx/Chapter/Chapter"
import { DuplicateIdError } from "@/components/mdx/_shared/components/DuplicateIdError"
import { ErrorSummaryBanner } from "../ErrorSummaryBanner"

/** The banner over the runbook, as App shows it. */
function Banner() {
  const { errors, errorCount, warningCount } = useErrorReporting()
  return <ErrorSummaryBanner errors={errors} errorCount={errorCount} warningCount={warningCount} />
}

/** Stands in for a block: reports an issue, and shows it where the summary can find it. */
function Issue({
  id,
  severity = "error",
  reported = true,
}: {
  id: string
  severity?: ErrorSeverity
  reported?: boolean
}) {
  const { reportError, clearError } = useErrorReporting()
  useEffect(() => {
    if (!reported) return
    reportError({ componentId: id, componentType: "Command", severity, message: `${id} is wrong` })
    return () => clearError(id)
  }, [id, severity, reported, reportError, clearError])
  return <div {...issueAnchor(id)} data-testid={id} />
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

describe("ErrorSummaryBanner", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it("goes to each issue in page order, one per click, then back to the first", async () => {
    const user = userEvent.setup()
    render(
      <TestWrapper>
        <Banner />
        <Issue id="first" severity="warning" />
        <Issue id="second" />
        <Issue id="third" />
      </TestWrapper>,
    )
    expect(await screen.findByText("This runbook has issues:")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Show details" }))
    expect(screen.getByText("1 of 3")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Next issue" }))
    expect(screen.getByText("2 of 3")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Next issue" }))
    expect(screen.getByText("3 of 3")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Next issue" }))
    expect(screen.getByText("1 of 3")).toBeInTheDocument()

    const [first, second, third] = ["first", "second", "third"].map((id) => screen.getByTestId(id))
    expect(scrolledTo()).toEqual([first, second, third, first])
  })

  it("keeps offering the one issue there is, with no count", async () => {
    const user = userEvent.setup()
    render(
      <TestWrapper>
        <Banner />
        <Issue id="only" />
      </TestWrapper>,
    )

    await user.click(await screen.findByRole("button", { name: "Show details" }))
    await user.click(screen.getByRole("button", { name: "Show details" }))

    const only = screen.getByTestId("only")
    expect(scrolledTo()).toEqual([only, only])
    expect(screen.queryByText(/of 1/)).toBeNull()
  })

  it("passes over a place that shows an issue no longer reported", async () => {
    const user = userEvent.setup()
    render(
      <TestWrapper>
        <Banner />
        <Issue id="fixed" reported={false} />
        <Issue id="broken" />
      </TestWrapper>,
    )

    await user.click(await screen.findByRole("button", { name: "Show details" }))

    expect(scrolledTo()).toEqual([screen.getByTestId("broken")])
  })

  it("goes on from the issue it went to last when one before it is fixed", async () => {
    const user = userEvent.setup()
    const issues = (firstReported: boolean) => (
      <TestWrapper>
        <Banner />
        <Issue id="first" reported={firstReported} />
        <Issue id="second" />
        <Issue id="third" />
      </TestWrapper>
    )
    const { rerender } = render(issues(true))
    await user.click(await screen.findByRole("button", { name: "Show details" }))
    await user.click(screen.getByRole("button", { name: "Next issue" }))

    rerender(issues(false))
    await user.click(screen.getByRole("button", { name: /Show details|Next issue/ }))

    const [first, second, third] = ["first", "second", "third"].map((id) => screen.getByTestId(id))
    expect(scrolledTo()).toEqual([first, second, third])
  })

  it("shows the hidden chapter an issue is in before going to it", async () => {
    const user = userEvent.setup()
    render(
      <TestWrapper>
        <Banner />
        <SetChapters titles={CHAPTER_TITLES} />
        <Chapter title="One" chapterIndex="0">
          <p>Nothing wrong here</p>
        </Chapter>
        <Chapter title="Two" chapterIndex="1">
          <Issue id="later" />
        </Chapter>
      </TestWrapper>,
    )
    const issue = screen.getByTestId("later")
    expect(issue).not.toBeVisible()

    await user.click(await screen.findByRole("button", { name: "Show details" }))

    expect(issue).toBeVisible()
    expect(scrolledTo()).toEqual([issue])
  })

  it("goes to the errors blocks show inline", async () => {
    const user = userEvent.setup()
    function DuplicateBlock() {
      const { reportError } = useErrorReporting()
      useEffect(() => {
        reportError({
          componentId: "deploy",
          componentType: "Command",
          severity: "error",
          message: "Duplicate component ID: deploy",
        })
      }, [reportError])
      return <DuplicateIdError id="deploy" isNormalizedCollision={false} componentName="Command" />
    }
    render(
      <TestWrapper>
        <Banner />
        <Admonition type={"tip" as AdmonitionType} />
        <DuplicateBlock />
      </TestWrapper>,
    )

    await user.click(await screen.findByRole("button", { name: "Show details" }))
    await user.click(screen.getByRole("button", { name: "Next issue" }))

    expect(scrolledTo()).toEqual([
      screen.getByText("Invalid Admonition Type").closest("[data-runbook-issue]"),
      screen.getByText("Duplicate Component ID:").closest("[data-runbook-issue]"),
    ])
  })
})
