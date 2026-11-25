import { describe, it, expect, afterEach } from "vitest"
import { useState, type ReactNode } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RunbookProgressProbe, TestWrapper } from "@/test/test-utils"
import { ProgressStep } from "@/components/mdx/_shared/components/ProgressStep"
import { useRunbookContext } from "@/contexts/useRunbook"
import { INSTRUCTION_MODE_STORAGE_KEY } from "@/contexts/InstructionModeContext.types"
import { compileMDX } from "@/components/MDXContainer"
import { ShowWhen } from "../ShowWhen"

/** Stands in for GitAuth: buttons that publish its GIT_PROVIDER output. */
function ProviderPicker() {
  const { registerOutputs } = useRunbookContext()
  return (
    <>
      <button type="button" onClick={() => registerOutputs("git-auth", { GIT_PROVIDER: "github" })}>
        Pick GitHub
      </button>
      <button type="button" onClick={() => registerOutputs("git-auth", { GIT_PROVIDER: "gitlab" })}>
        Pick GitLab
      </button>
    </>
  )
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

function renderWithPicker(children: ReactNode) {
  return render(
    <TestWrapper>
      <ProviderPicker />
      {children}
      <RunbookProgressProbe />
    </TestWrapper>,
  )
}

const text = (content: string) => screen.getByText(content)

afterEach(() => localStorage.clear())

describe("ShowWhen", () => {
  it("shows its content before the output exists, unless whenUnknown is hide", () => {
    renderWithPicker(
      <>
        <ShowWhen output="git_auth.GIT_PROVIDER" equals="gitlab">
          <p>GitLab steps</p>
        </ShowWhen>
        <ShowWhen output="git_auth.GIT_PROVIDER" equals="gitlab" whenUnknown="hide">
          <p>GitLab steps, once known</p>
        </ShowWhen>
      </>,
    )

    expect(text("GitLab steps")).toBeVisible()
    expect(text("GitLab steps, once known")).not.toBeVisible()
  })

  it("follows the output as it changes", async () => {
    const user = userEvent.setup()
    renderWithPicker(
      <>
        <ShowWhen output="git_auth.GIT_PROVIDER" equals="github">
          <p>GitHub steps</p>
        </ShowWhen>
        <ShowWhen output="git_auth.GIT_PROVIDER" equals="gitlab">
          <p>GitLab steps</p>
        </ShowWhen>
      </>,
    )

    await user.click(screen.getByRole("button", { name: "Pick GitLab" }))
    expect(text("GitHub steps")).not.toBeVisible()
    expect(text("GitLab steps")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Pick GitHub" }))
    expect(text("GitHub steps")).toBeVisible()
    expect(text("GitLab steps")).not.toBeVisible()
  })

  it("reads an output by the block id as written, hyphens and all", async () => {
    const user = userEvent.setup()
    renderWithPicker(
      <ShowWhen output="git-auth.GIT_PROVIDER" equals="gitlab" whenUnknown="hide">
        <p>GitLab steps</p>
      </ShowWhen>,
    )

    await user.click(screen.getByRole("button", { name: "Pick GitLab" }))
    expect(text("GitLab steps")).toBeVisible()
  })

  it("compares with notEquals and in", async () => {
    const user = userEvent.setup()
    renderWithPicker(
      <>
        <ShowWhen output="git_auth.GIT_PROVIDER" notEquals="gitlab">
          <p>Not GitLab</p>
        </ShowWhen>
        <ShowWhen output="git_auth.GIT_PROVIDER" in={["github", "ghe"]}>
          <p>Some GitHub</p>
        </ShowWhen>
      </>,
    )

    await user.click(screen.getByRole("button", { name: "Pick GitLab" }))
    expect(text("Not GitLab")).not.toBeVisible()
    expect(text("Some GitHub")).not.toBeVisible()

    await user.click(screen.getByRole("button", { name: "Pick GitHub" }))
    expect(text("Not GitLab")).toBeVisible()
    expect(text("Some GitHub")).toBeVisible()
  })

  it("keeps hidden blocks mounted, with their state, but out of the progress count", async () => {
    const user = userEvent.setup()
    renderWithPicker(
      <>
        <Step name="shared" />
        <ShowWhen output="git_auth.GIT_PROVIDER" equals="gitlab">
          <Step name="gitlab" />
        </ShowWhen>
      </>,
    )

    await user.click(screen.getByRole("button", { name: "Do gitlab" }))
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("1/2")

    await user.click(screen.getByRole("button", { name: "Pick GitHub" }))
    const hidden = screen.getByRole("button", { name: "Undo gitlab", hidden: true })
    expect(hidden).not.toBeVisible()
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/1")

    await user.click(screen.getByRole("button", { name: "Pick GitLab" }))
    expect(screen.getByRole("button", { name: "Undo gitlab" })).toBe(hidden)
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("1/2")
  })

  it("hides content in a nested ShowWhen when either one hides it", async () => {
    const user = userEvent.setup()
    renderWithPicker(
      <ShowWhen output="git_auth.GIT_PROVIDER" in={["github", "gitlab"]}>
        <p>Any provider</p>
        <ShowWhen output="git_auth.GIT_PROVIDER" equals="gitlab">
          <p>GitLab only</p>
        </ShowWhen>
      </ShowWhen>,
    )

    await user.click(screen.getByRole("button", { name: "Pick GitHub" }))
    expect(text("Any provider")).toBeVisible()
    expect(text("GitLab only")).not.toBeVisible()

    await user.click(screen.getByRole("button", { name: "Pick GitLab" }))
    expect(text("GitLab only")).toBeVisible()
  })

  it("shows every case in instruction mode, each with its condition", async () => {
    localStorage.setItem(INSTRUCTION_MODE_STORAGE_KEY, "true")
    const user = userEvent.setup()
    renderWithPicker(
      <ShowWhen output="git_auth.GIT_PROVIDER" equals="gitlab" whenUnknown="hide">
        <p>GitLab steps</p>
      </ShowWhen>,
    )

    expect(text("GitLab steps")).toBeVisible()
    expect(text('Only when git_auth.GIT_PROVIDER is "gitlab":')).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Pick GitHub" }))
    expect(text("GitLab steps")).toBeVisible()
  })

  it("shows a configuration error, with its content, for props it can't read", () => {
    renderWithPicker(
      <ShowWhen output="git_auth.GIT_PROVIDER">
        <p>Content</p>
      </ShowWhen>,
    )

    expect(text("Invalid ShowWhen")).toBeVisible()
    expect(text("<ShowWhen> takes exactly one of equals, notEquals or in.")).toBeVisible()
    expect(text("Content")).toBeVisible()
  })
})

describe("ShowWhen in a runbook", () => {
  const RUNBOOK = `# Set up Pipelines

<ShowWhen output="git_auth.GIT_PROVIDER" equals="github">

**On GitHub**, install the app.

</ShowWhen>

<ShowWhen output="git_auth.GIT_PROVIDER" equals="gitlab">

**On GitLab**, add a token:

- Create a project access token.

<Admonition type="note" title="Default branch">

Pipelines applies on the default branch.

</Admonition>

</ShowWhen>
`

  it("compiles, and shows only the selected provider's markdown and blocks", async () => {
    const user = userEvent.setup()
    // The compiled runbook, without MDXContainer's own RunbookContext, so the
    // picker's outputs reach it
    const Content = await compileMDX(RUNBOOK)
    render(
      <TestWrapper>
        <ProviderPicker />
        <Content />
      </TestWrapper>,
    )

    const github = await screen.findByText(/install the app/)
    const token = screen.getByText("Create a project access token.")
    const note = screen.getByText("Pipelines applies on the default branch.")
    expect(github).toBeVisible()
    expect(token).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Pick GitLab" }))
    expect(github).not.toBeVisible()
    expect(token).toBeVisible()
    expect(note).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Pick GitHub" }))
    expect(github).toBeVisible()
    expect(token).not.toBeVisible()
    expect(note).not.toBeVisible()
  })
})
