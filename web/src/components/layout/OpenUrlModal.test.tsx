import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type TestApi } from "@/test/test-api"
import { OpenUrlModal } from "./OpenUrlModal"

// The IPC boundary is the only thing faked: the main process parses the
// source, so the modal must hand over whatever the user typed.
let testApi: TestApi

/** Render the modal, type `source` and press Open; returns the onOpenChange and onOpened spies. */
async function submit(source: string) {
  const onOpenChange = vi.fn()
  const onOpened = vi.fn()
  render(
    <ApiProvider api={testApi.api}>
      <OpenUrlModal open onOpenChange={onOpenChange} onOpened={onOpened} />
    </ApiProvider>,
  )
  await userEvent.type(screen.getByRole("textbox"), source)
  await userEvent.click(screen.getByRole("button", { name: "Open" }))
  return { onOpenChange, onOpened }
}

describe("OpenUrlModal", () => {
  beforeEach(() => {
    testApi = makeTestApi()
  })

  it.each([
    "github.com/org/repo//runbooks/setup-vpc?ref=v1.0",
    "git@github.com:org/repo.git//runbooks/setup-vpc",
    "https://gitlab.com/group/sub/repo/-/tree/main/runbooks/setup-vpc?ref_type=heads",
  ])("sends %s to the main process and closes", async (source) => {
    testApi.handle("runbook:open-remote", () => ({
      path: "/tmp/x/runbook.mdx",
      remoteSource: source,
    }))
    const { onOpenChange, onOpened } = await submit(source)
    expect(testApi.invoke).toHaveBeenCalledWith("runbook:open-remote", { url: source })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(onOpened).toHaveBeenCalledWith("/tmp/x/runbook.mdx", source)
  })

  it("shows the main process's message without Electron's IPC wrapper", async () => {
    testApi.handle("runbook:open-remote", () => {
      throw new Error(
        `Error invoking remote method 'runbook:open-remote': Error: "runbooks/nope" was not found in github.com/org/repo`,
      )
    })
    const { onOpenChange, onOpened } = await submit("github.com/org/repo//runbooks/nope")
    expect(
      await screen.findByText('"runbooks/nope" was not found in github.com/org/repo'),
    ).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onOpened).not.toHaveBeenCalled()
  })
})
