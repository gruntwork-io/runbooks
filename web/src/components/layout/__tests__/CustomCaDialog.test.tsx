import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CustomCaDialog } from "../CustomCaDialog"
import type { CaCertificateSummary, CustomCaStatus } from "../../../../../src/domain/tls/customCa"

// The IPC boundary is the only thing mocked: main reads, saves and installs the file.
const invoke = vi.fn()
const api = { invoke, on: () => () => {} }

vi.mock("@/contexts/ApiContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/ApiContext")>()
  return { ...actual, useApi: () => api }
})

const ROOT: CaCertificateSummary = {
  subject: "Acme Root CA",
  issuer: "Acme Root CA",
  validFrom: "2024-01-01T00:00:00.000Z",
  validTo: "2099-01-01T00:00:00.000Z",
  fingerprint256: "AA:BB:CC",
  isCa: true,
}
const INTERMEDIATE: CaCertificateSummary = {
  ...ROOT,
  subject: "Acme Issuing CA",
  validTo: "2020-06-01T00:00:00.000Z",
  fingerprint256: "DD:EE:FF",
}

const NONE: CustomCaStatus = { certificates: [] }
const SET: CustomCaStatus = { path: "/certs/acme.pem", certificates: [ROOT, INTERMEDIATE] }

/** Main's answers, by channel. Each test overrides what it needs. */
let answers: Record<string, () => unknown>

beforeEach(() => {
  invoke.mockReset()
  answers = {
    "tls:custom-ca-status": () => NONE,
    "tls:choose-custom-ca": () => ({ status: SET }),
    "tls:clear-custom-ca": () => ({ status: NONE }),
  }
  invoke.mockImplementation(async (channel: string) => answers[channel]!())
})

const callsTo = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel)

describe("CustomCaDialog", () => {
  it("says no certificate is set, and offers to choose one", async () => {
    render(<CustomCaDialog open onOpenChange={vi.fn()} />)

    expect(await screen.findByText("No custom CA certificate is set.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Choose File…" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull()
  })

  it("lists the file's certificates: who issued each, when it expires, and its fingerprint", async () => {
    answers["tls:custom-ca-status"] = () => SET
    render(<CustomCaDialog open onOpenChange={vi.fn()} />)

    expect(await screen.findByText("/certs/acme.pem")).toBeInTheDocument()
    expect(screen.getByText("Acme Root CA")).toBeInTheDocument()
    expect(screen.getByText(/Self-signed · Expires/)).toBeInTheDocument()
    expect(screen.getByText("AA:BB:CC")).toBeInTheDocument()
    // The second one was issued by the first, and has expired.
    expect(screen.getByText(/Issued by Acme Root CA/)).toBeInTheDocument()
    expect(screen.getByText(/^Expired /)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Choose Another File…" })).toBeInTheDocument()
  })

  it("says why a saved file isn't trusted, such as when it's gone", async () => {
    answers["tls:custom-ca-status"] = () => ({
      path: "/certs/gone.pem",
      certificates: [],
      error: "The file isn't there anymore.",
    })
    render(<CustomCaDialog open onOpenChange={vi.fn()} />)

    expect(
      await screen.findByText("Not trusted: The file isn't there anymore."),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument()
  })

  it("shows the certificates of the file chosen in main's file dialog", async () => {
    const user = userEvent.setup()
    render(<CustomCaDialog open onOpenChange={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: "Choose File…" }))

    expect(await screen.findByText("Acme Issuing CA")).toBeInTheDocument()
    expect(callsTo("tls:choose-custom-ca")).toHaveLength(1)
  })

  it("keeps the current setting and says why when the file chosen has no certificate", async () => {
    const user = userEvent.setup()
    answers["tls:custom-ca-status"] = () => SET
    answers["tls:choose-custom-ca"] = () => ({
      status: SET,
      rejected: "The file has no certificates. Choose the CA's certificate, not a key.",
    })
    render(<CustomCaDialog open onOpenChange={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: "Choose Another File…" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("not a key")
    expect(screen.getByText("Acme Root CA")).toBeInTheDocument()
  })

  it("changes nothing when the file dialog is canceled", async () => {
    const user = userEvent.setup()
    answers["tls:choose-custom-ca"] = () => ({ status: NONE, canceled: true })
    render(<CustomCaDialog open onOpenChange={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: "Choose File…" }))

    await waitFor(() => expect(screen.getByRole("button", { name: "Choose File…" })).toBeEnabled())
    expect(screen.getByText("No custom CA certificate is set.")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("removes the custom CA", async () => {
    const user = userEvent.setup()
    answers["tls:custom-ca-status"] = () => SET
    render(<CustomCaDialog open onOpenChange={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: "Remove" }))

    expect(await screen.findByText("No custom CA certificate is set.")).toBeInTheDocument()
    expect(callsTo("tls:clear-custom-ca")).toHaveLength(1)
  })

  it("keeps the custom CA and says why when it can't be removed", async () => {
    const user = userEvent.setup()
    answers["tls:custom-ca-status"] = () => SET
    answers["tls:clear-custom-ca"] = () => ({
      status: SET,
      rejected:
        "The certificate bundle for scripts can't be written: ENOSPC: no space left on device",
    })
    render(<CustomCaDialog open onOpenChange={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: "Remove" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("ENOSPC")
    expect(screen.getByText("Acme Root CA")).toBeInTheDocument()
  })

  it("shows a failed request's error", async () => {
    const user = userEvent.setup()
    answers["tls:custom-ca-status"] = () => SET
    answers["tls:clear-custom-ca"] = () => {
      throw new Error("EACCES: permission denied")
    }
    render(<CustomCaDialog open onOpenChange={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: "Remove" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("EACCES: permission denied")
  })

  it("closes on Done", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<CustomCaDialog open onOpenChange={onOpenChange} />)

    await user.click(await screen.findByRole("button", { name: "Done" }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
