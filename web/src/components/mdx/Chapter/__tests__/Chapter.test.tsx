import { describe, it, expect } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import MDXContainer from "@/components/MDXContainer"

const RUNBOOK = `# Guide

Read this first.

<Chapter title="Set up">

## Install

Install the tools.

</Chapter>

<Chapter title="Deploy">

## Ship it

Run the deploy.

</Chapter>

<Chapter title="Verify">

## Check

Check the app.

</Chapter>
`

function container(content: string, key?: string) {
  return (
    <TestWrapper>
      <MDXContainer key={key} content={content} runbookPath="testdata/chapters" />
    </TestWrapper>
  )
}

/** Render `content` and wait for it to compile. */
async function renderRunbook(content: string) {
  const result = render(container(content))
  await screen.findByTestId("runbook-content")
  return result
}

const bar = () => screen.getByRole("navigation", { name: "Chapters" })
const position = () => screen.getByTestId("chapter-bar-position").textContent
const heading = (name: string) => screen.getByRole("heading", { name, hidden: true })

describe("Chapter", () => {
  it("shows one chapter at a time, with the content outside every chapter", async () => {
    await renderRunbook(RUNBOOK)

    expect(await screen.findByRole("heading", { name: "Install" })).toBeVisible()
    expect(heading("Ship it")).not.toBeVisible()
    expect(heading("Check")).not.toBeVisible()
    expect(screen.getByText("Read this first.")).toBeVisible()
    expect(position()).toBe("Chapter 1 of 3 · Set up")
  })

  it("has no chapter bar or pager for a runbook without chapters, or with only one", async () => {
    const { rerender } = await renderRunbook("# Guide\n\n## Install\n\nInstall the tools.\n")
    expect(await screen.findByRole("heading", { name: "Install" })).toBeVisible()
    expect(screen.queryByRole("navigation")).toBeNull()

    rerender(container('# Guide\n\n<Chapter title="Only">\n\n## Alone\n\n</Chapter>\n'))
    expect(await screen.findByRole("heading", { name: "Alone" })).toBeVisible()
    expect(screen.queryByRole("navigation")).toBeNull()
  })

  it("moves with the bar's buttons, which stop at the first and last chapters", async () => {
    const user = userEvent.setup()
    await renderRunbook(RUNBOOK)
    await screen.findByRole("heading", { name: "Install" })

    expect(within(bar()).getByRole("button", { name: "Previous chapter" })).toBeDisabled()
    await user.click(within(bar()).getByRole("button", { name: "Next chapter: Deploy" }))
    expect(heading("Ship it")).toBeVisible()
    expect(heading("Install")).not.toBeVisible()
    expect(position()).toBe("Chapter 2 of 3 · Deploy")

    await user.click(within(bar()).getByRole("button", { name: "Next chapter: Verify" }))
    expect(heading("Check")).toBeVisible()
    expect(within(bar()).getByRole("button", { name: "Next chapter" })).toBeDisabled()

    await user.click(within(bar()).getByRole("button", { name: "Previous chapter: Deploy" }))
    expect(heading("Ship it")).toBeVisible()
  })

  it("moves with the links at the end of the chapter, and puts focus in the chapter it moves to", async () => {
    const user = userEvent.setup()
    await renderRunbook(RUNBOOK)
    await screen.findByRole("heading", { name: "Install" })

    const pager = () => screen.getByRole("navigation", { name: "Chapter pages" })
    // The first chapter has nowhere back to go.
    expect(within(pager()).getAllByRole("button")).toHaveLength(1)
    await user.click(within(pager()).getByRole("button", { name: /Deploy/ }))

    expect(heading("Ship it")).toBeVisible()
    expect(screen.getByRole("region", { name: "Deploy" })).toHaveFocus()
    expect(
      within(pager())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["PreviousSet up", "NextVerify"])
  })

  it("lists every chapter in the table of contents, and goes to the one picked", async () => {
    const user = userEvent.setup()
    await renderRunbook(RUNBOOK)
    await screen.findByRole("heading", { name: "Install" })

    await user.click(within(bar()).getByRole("button", { name: "Contents" }))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((item) => item.textContent)).toEqual(["1Set up", "2Deploy", "3Verify"])
    expect(items[0]).toHaveAttribute("aria-current", "page")

    await user.click(screen.getByRole("menuitem", { name: /Verify/ }))
    expect(heading("Check")).toBeVisible()
    expect(heading("Install")).not.toBeVisible()
    expect(screen.getByRole("region", { name: "Verify" })).toHaveFocus()
  })

  it("keeps the chapter on screen through a watch-mode reload, and starts another runbook at its first", async () => {
    const user = userEvent.setup()
    const { rerender } = await renderRunbook(RUNBOOK)
    await screen.findByRole("heading", { name: "Install" })
    await user.click(within(bar()).getByRole("button", { name: "Next chapter: Deploy" }))

    rerender(container(RUNBOOK.replace("Run the deploy.", "Run the new deploy.")))
    expect(await screen.findByText("Run the new deploy.")).toBeVisible()
    expect(position()).toBe("Chapter 2 of 3 · Deploy")

    // A reload that takes away the chapter on screen shows the last one left.
    await user.click(within(bar()).getByRole("button", { name: "Next chapter: Verify" }))
    rerender(container(RUNBOOK.slice(0, RUNBOOK.indexOf('<Chapter title="Verify">'))))
    await waitFor(() => expect(position()).toBe("Chapter 2 of 2 · Deploy"))
    expect(heading("Ship it")).toBeVisible()

    // Another runbook or session mounts a new container.
    rerender(container(RUNBOOK, "another-session"))
    await waitFor(() => expect(position()).toBe("Chapter 1 of 3 · Set up"))
    expect(heading("Install")).toBeVisible()
  })

  it("names a chapter by a title written as a literal expression, or by its number with none", async () => {
    const user = userEvent.setup()
    await renderRunbook(
      [
        '<Chapter title={"Set up"}>\n\nOne.\n\n</Chapter>',
        "<Chapter>\n\nTwo.\n\n</Chapter>",
        // A literal that isn't text counts as no title.
        "<Chapter title={42}>\n\nThree.\n\n</Chapter>",
      ].join("\n\n"),
    )
    await waitFor(() => expect(position()).toBe("Chapter 1 of 3 · Set up"))

    await user.click(within(bar()).getByRole("button", { name: "Next chapter: Chapter 2" }))
    expect(screen.getByText("Two.")).toBeVisible()
    expect(screen.getByText(/Chapter 2 has no title/)).toBeVisible()

    await user.click(within(bar()).getByRole("button", { name: "Next chapter: Chapter 3" }))
    expect(screen.getByText("Three.")).toBeVisible()
    expect(screen.getByRole("region", { name: "Chapter 3" })).toBeVisible()
    expect(screen.getByText(/Chapter 3 has no title/)).toBeVisible()
  })

  it("reports a chapter that isn't at the top level, and shows its content where it is", async () => {
    await renderRunbook(
      [
        '<Chapter title="Outer">',
        "",
        "Outer text.",
        "",
        // An index written in the runbook is ignored.
        '<Chapter title="Inner" chapterIndex="0">',
        "",
        "Inner text.",
        "",
        "</Chapter>",
        "",
        "</Chapter>",
        "",
        '<Admonition type="info">',
        "",
        '<Chapter title="Boxed">',
        "",
        "Boxed text.",
        "",
        "</Chapter>",
        "",
        "</Admonition>",
        "",
      ].join("\n"),
    )

    expect(await screen.findByText("Inner text.")).toBeVisible()
    expect(screen.getByText("Boxed text.")).toBeVisible()
    expect(screen.getAllByText(/must be at the top level of the runbook/)).toHaveLength(2)
    // The one chapter left is the runbook in one piece.
    expect(screen.queryByRole("navigation", { name: "Chapters" })).toBeNull()
  })

  it("shows the chapter a link's target is in before scrolling to it", async () => {
    const user = userEvent.setup()
    await renderRunbook(
      [
        '<Chapter title="Set up">',
        "",
        "See [the deploy step](#deploy-step).",
        "",
        "</Chapter>",
        "",
        '<Chapter title="Deploy">',
        "",
        '<p id="deploy-step">The deploy step.</p>',
        "",
        "</Chapter>",
        "",
      ].join("\n"),
    )

    await user.click(await screen.findByRole("link", { name: "the deploy step" }))
    expect(screen.getByText("The deploy step.")).toBeVisible()
    expect(position()).toBe("Chapter 2 of 2 · Deploy")
  })
})
