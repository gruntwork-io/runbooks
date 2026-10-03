import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { SessionName } from "../SessionName"

// The IPC boundary is the only thing mocked: the main process owns the
// session and knows the other sessions' names.
const invoke = vi.fn()

vi.mock("@/contexts/ApiContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/ApiContext")>()
  return { ...actual, useApi: () => ({ invoke, on: vi.fn(() => () => {}) }) }
})

/** The name as the header holds it: renaming is the header's state, the name the app's. */
function Harness({ onRenamed }: { onRenamed: (name: string) => void }) {
  const [name, setName] = useState("elegant-elephant")
  const [isRenaming, setIsRenaming] = useState(false)
  return (
    <>
      <SessionName
        name={name}
        isRenaming={isRenaming}
        onRenamingChange={setIsRenaming}
        onRenamed={(renamed) => {
          setName(renamed)
          onRenamed(renamed)
        }}
      />
      <button>Elsewhere</button>
    </>
  )
}

/** Render the name and shift-click it; returns the field and the onRenamed spy. */
async function startRenaming() {
  const onRenamed = vi.fn()
  render(<Harness onRenamed={onRenamed} />)
  fireEvent.click(screen.getByRole("button", { name: "elegant-elephant" }), { shiftKey: true })
  return { field: screen.getByRole("textbox", { name: "Session name" }), onRenamed }
}

describe("SessionName", () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it("copies the name when clicked, and stays a name", async () => {
    const user = userEvent.setup()
    render(<Harness onRenamed={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "elegant-elephant" }))

    expect(await navigator.clipboard.readText()).toBe("elegant-elephant")
    expect(await screen.findByLabelText("Copied")).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("turns into a field with the name selected when shift-clicked", async () => {
    const { field } = await startRenaming()

    expect(field).toHaveValue("elegant-elephant")
    expect(field).toHaveFocus()
    // Typing replaces the selected name.
    await userEvent.keyboard("x")
    expect(field).toHaveValue("x")
  })

  it("renames the session on Enter and shows the name the main process returns", async () => {
    invoke.mockResolvedValue({ name: "prod-deploy" })
    const { onRenamed } = await startRenaming()

    await userEvent.keyboard("prod-deploy{Enter}")

    expect(invoke).toHaveBeenCalledWith("session:rename", { name: "prod-deploy" })
    expect(await screen.findByRole("button", { name: "prod-deploy" })).toBeInTheDocument()
    expect(onRenamed).toHaveBeenCalledWith("prod-deploy")
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("lowercases what is typed and stops at 63 characters", async () => {
    const { field } = await startRenaming()

    await userEvent.keyboard("Prod-Deploy")
    expect(field).toHaveValue("prod-deploy")

    await userEvent.clear(field)
    await userEvent.type(field, "a".repeat(70))
    expect(field).toHaveValue("a".repeat(63))
  })

  it("explains a name that is not allowed without asking the main process", async () => {
    const { field, onRenamed } = await startRenaming()

    await userEvent.keyboard("prod deploy{Enter}")

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Use lowercase letters, digits and hyphens",
    )
    expect(field).toBeInvalid()
    expect(invoke).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()

    // The message goes once the name is edited.
    await userEvent.keyboard("{Backspace}")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("shows the main process's reason when it refuses the name, and keeps the field open", async () => {
    invoke.mockRejectedValue(new Error("Another session is already named brave-otter."))
    const { field, onRenamed } = await startRenaming()

    await userEvent.keyboard("brave-otter{Enter}")

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Another session is already named brave-otter.",
    )
    expect(onRenamed).not.toHaveBeenCalled()
    await waitFor(() => expect(field).toHaveFocus())
    expect(field).toHaveValue("brave-otter")
  })

  it("leaves the name as it was on Escape", async () => {
    const { onRenamed } = await startRenaming()

    await userEvent.keyboard("prod-deploy{Escape}")

    expect(screen.getByRole("button", { name: "elegant-elephant" })).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it("leaves the name as it was when the field loses focus", async () => {
    await startRenaming()

    await userEvent.keyboard("prod-deploy")
    await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }))

    expect(screen.getByRole("button", { name: "elegant-elephant" })).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("drops the spaces around a name before checking or sending it", async () => {
    invoke.mockResolvedValue({ name: "prod-deploy" })
    await startRenaming()

    await userEvent.keyboard("  prod-deploy {Enter}")

    expect(invoke).toHaveBeenCalledWith("session:rename", { name: "prod-deploy" })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("treats the name with spaces around it as unchanged", async () => {
    const { field } = await startRenaming()

    await userEvent.clear(field)
    await userEvent.keyboard(" elegant-elephant {Enter}")

    expect(screen.getByRole("button", { name: "elegant-elephant" })).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("keeps the field, disabled, while the main process renames, even if it loses focus", async () => {
    let finish!: (value: { name: string }) => void
    invoke.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const { field, onRenamed } = await startRenaming()
    expect(field).toHaveAttribute("aria-invalid", "false")

    await userEvent.keyboard("prod-deploy{Enter}")
    expect(field).toBeDisabled()
    fireEvent.blur(field)
    expect(screen.getByRole("textbox", { name: "Session name" })).toBe(field)

    finish({ name: "prod-deploy" })
    expect(await screen.findByRole("button", { name: "prod-deploy" })).toBeInTheDocument()
    expect(onRenamed).toHaveBeenCalledWith("prod-deploy")
  })

  it("lets the user edit again after the main process refuses the name", async () => {
    invoke.mockRejectedValue(new Error("Another session is already named brave-otter."))
    const { field } = await startRenaming()

    await userEvent.keyboard("brave-otter{Enter}")

    await screen.findByRole("alert")
    expect(field).toBeEnabled()
    expect(field).toHaveAttribute("aria-invalid", "true")
    await userEvent.keyboard("{Backspace}")
    expect(field).toHaveAttribute("aria-invalid", "false")
  })

  it("closes the field without a rename when Enter is pressed on the unchanged name", async () => {
    await startRenaming()

    await userEvent.keyboard("{Enter}")

    expect(screen.getByRole("button", { name: "elegant-elephant" })).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
  })
})
