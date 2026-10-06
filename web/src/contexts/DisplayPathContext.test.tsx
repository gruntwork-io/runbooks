import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { ApiProvider, type RunbooksAPI } from "./ApiContext"
import { DisplayPathProvider } from "./DisplayPathContext"
import { useDisplayPath } from "./useDisplayPath"

const HOME = "/Users/me"
const SESSION = `${HOME}/Library/Application Support/Runbooks/v0/sessions/dirs/0199a5c2`

function Shown({ path }: { path: string }) {
  return <p>{useDisplayPath()(path)}</p>
}

function renderWith(invoke: RunbooksAPI["invoke"], sessionDir: string | undefined) {
  const api = { invoke, on: () => () => {} } as unknown as RunbooksAPI
  render(
    <ApiProvider api={api}>
      <DisplayPathProvider sessionDir={sessionDir}>
        <Shown path={`${SESSION}/generated`} />
        <Shown path={`${HOME}/dev/infra`} />
      </DisplayPathProvider>
    </ApiProvider>,
  )
}

describe("DisplayPathProvider", () => {
  it("shortens against the open session's directory and the home directory main reports", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "native:get-home-dir") return { path: HOME }
      throw new Error(`unexpected channel ${channel}`)
    })
    renderWith(invoke as unknown as RunbooksAPI["invoke"], SESSION)

    expect(screen.getByText("session/generated")).toBeInTheDocument()
    expect(await screen.findByText("~/dev/infra")).toBeInTheDocument()
  })

  it("shows paths in full when main can't say where home is, and with no session open", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("no handler")
    })
    renderWith(invoke as unknown as RunbooksAPI["invoke"], undefined)

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("native:get-home-dir"))
    expect(screen.getByText(`${SESSION}/generated`)).toBeInTheDocument()
    expect(screen.getByText(`${HOME}/dev/infra`)).toBeInTheDocument()
  })

  it("leaves text as it is outside a provider", () => {
    render(<Shown path={`${SESSION}/generated`} />)

    expect(screen.getByText(`${SESSION}/generated`)).toBeInTheDocument()
  })
})
