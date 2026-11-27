import { describe, it, expect } from "vitest"
import { useEffect } from "react"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import { GitPullRequestInstruction } from "../GitPullRequestInstruction"

function Seed({ id, values }: { id: string; values: Record<string, string> }) {
  const { registerOutputs } = useRunbookContext()
  useEffect(() => {
    registerOutputs(id, values)
  }, [id, values, registerOutputs])
  return null
}

describe("GitPullRequestInstruction with both gitAuthId and githubAuthId", () => {
  it("gives the command of the gitAuthId block's provider", async () => {
    render(
      <TestWrapper>
        <Seed id="gh" values={{ GIT_PROVIDER: "github", GITHUB_TOKEN: "tok" }} />
        <Seed id="gl" values={{ GIT_PROVIDER: "gitlab", GITLAB_TOKEN: "tok" }} />
        <GitPullRequestInstruction id="pr" gitAuthId="gl" githubAuthId="gh" />
      </TestWrapper>,
    )
    expect(await screen.findByText(/glab mr create/)).toBeInTheDocument()
    expect(screen.queryByText(/gh pr create/)).toBeNull()
  })
})
