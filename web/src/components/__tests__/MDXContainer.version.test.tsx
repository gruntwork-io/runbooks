import { describe, it, expect } from "vitest"
import { render, screen, within } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import MDXContainer from "../MDXContainer"
import { RUNBOOKS_VERSION } from "../../../../src/runbooks-version"

/** Render `content`, and the error box it's refused with. */
async function refusal(content: string) {
  render(
    <TestWrapper>
      <MDXContainer content={content} />
    </TestWrapper>,
  )
  const box = await screen.findByTestId("mdx-error")
  return {
    title: within(box).getByRole("heading").textContent,
    details: box.querySelector("pre")?.textContent,
  }
}

describe("MDXContainer, for a runbook this version of Runbooks can't open", () => {
  it("names the blocks it doesn't have, wherever they are, before rendering any of the runbook", async () => {
    const { title, details } = await refusal(
      [
        "# Guide",
        "",
        '<Admonition type="info">',
        "",
        "Inline <Badge>new</Badge> text.",
        "",
        "</Admonition>",
        "",
        '<Quiz title="One">',
        "",
        "One.",
        "",
        "</Quiz>",
        "",
      ].join("\n"),
    )

    expect(title).toBe("Runbooks can't open this runbook")
    expect(details).toBe(
      `This runbook uses <Badge> and <Quiz>, blocks that Runbooks ${RUNBOOKS_VERSION} doesn't have. If a later version of Runbooks added them, update Runbooks to use this runbook. Otherwise, check their names.`,
    )
    expect(screen.queryByText("Guide")).toBeNull()
  })

  it("says which version the runbook needs, before reading the rest of it", async () => {
    const { title, details } = await refusal(
      [
        "---",
        "title: Too new",
        'runbooks: ">= 999"',
        "---",
        "",
        "# Guide",
        "",
        "<Quiz />",
        "",
      ].join("\n"),
    )

    expect(title).toBe("Runbooks can't open this runbook")
    expect(details).toBe(
      `This runbook needs Runbooks >= 999, and this is Runbooks ${RUNBOOKS_VERSION}. Update Runbooks to use it.`,
    )
  })

  it("reports a requirement it can't read", async () => {
    const { details } = await refusal('---\nrunbooks: "latest"\n---\n\n# Guide\n')
    expect(details).toContain("`runbooks` in the front matter isn't a version of Runbooks")
  })

  it("opens a runbook whose requirement this version meets", async () => {
    render(
      <TestWrapper>
        <MDXContainer
          content={`---\nrunbooks: ">= 0.1, <= ${RUNBOOKS_VERSION}"\n---\n\n# Guide\n`}
        />
      </TestWrapper>,
    )
    expect(await screen.findByRole("heading", { name: "Guide" })).toBeVisible()
    expect(screen.queryByTestId("mdx-error")).toBeNull()
  })
})
