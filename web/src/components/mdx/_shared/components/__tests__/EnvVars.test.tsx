import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { EnvVars } from "../EnvVars"
import { outputRef, type EnvVar } from "../../lib/outputOverrides"
import {
  isSensitiveOutput,
  revealOutput,
  sensitiveOutput,
  type OutputValue,
} from "@/lib/outputValues"

const title = outputRef("fetch-pr", "title")

/** PR_TITLE, read from fetch-pr's title output between brackets. */
function prTitle(output: OutputValue | undefined, override?: OutputValue): EnvVar {
  return {
    name: "PR_TITLE",
    value: "rendered elsewhere",
    parts: [
      { kind: "text", text: "[" },
      { kind: "output", ref: title, output, override },
      { kind: "text", text: "]" },
    ],
  }
}

function setup(envVars: EnvVar[], disabled = false) {
  const user = userEvent.setup()
  const onOverride = vi.fn()
  const onReset = vi.fn()
  render(
    <EnvVars
      blockId="print-title"
      envVars={envVars}
      onOverride={onOverride}
      onReset={onReset}
      disabled={disabled}
    />,
  )
  return { user, onOverride, onReset }
}

describe("EnvVars", () => {
  it("shows a value that reads no output as it is", () => {
    setup([{ name: "REGION", value: "us-west-2" }])

    expect(screen.getByText("REGION")).toBeInTheDocument()
    expect(screen.getByText("us-west-2")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("shows an output that hasn't been produced as a chip naming it", () => {
    setup([prTitle(undefined)])

    const chip = screen.getByRole("button", { name: /^fetch-pr\.title: Waiting for fetch-pr/ })
    expect(chip).toHaveAttribute("data-state", "waiting")
    expect(chip).toHaveTextContent("fetch-pr.title")
    expect(screen.getByTestId("print-title-env")).toHaveTextContent("PR_TITLE[fetch-pr.title]")
  })

  it("shows an output's value in its chip, and a secret as <redacted>", () => {
    setup([prTitle("Fix it"), { ...prTitle(sensitiveOutput("s3cr3t")), name: "TOKEN" }])

    const [plain, secret] = screen.getAllByRole("button")
    expect(plain).toHaveAttribute("data-state", "linked")
    expect(plain).toHaveTextContent("Fix it")
    expect(secret).toHaveTextContent("<redacted>")
    expect(document.body.innerHTML).not.toContain("s3cr3t")
  })

  it("turns into a field in its place, and uses the value entered there", async () => {
    const { user, onOverride } = setup([prTitle("Fix it")])

    await user.click(screen.getByRole("button", { name: "fetch-pr.title: Fix it" }))
    const field = screen.getByLabelText("Value for fetch-pr.title")
    // In the chip's place, focused, with the value the script would get, selected
    expect(screen.getByTestId("print-title-env")).toHaveTextContent("PR_TITLE[]")
    expect(screen.queryByRole("button", { name: /^fetch-pr\.title/ })).not.toBeInTheDocument()
    expect(field).toHaveFocus()
    expect(field).toHaveValue("Fix it")

    await user.keyboard("Fix it properly{Enter}")

    expect(onOverride).toHaveBeenCalledWith(title, "Fix it properly")
    expect(field).not.toHaveFocus()
  })

  it("keeps a change when the user leaves the field, and nothing otherwise", async () => {
    const { user, onOverride } = setup([prTitle("Fix it")])
    const chip = () => screen.getByRole("button", { name: "fetch-pr.title: Fix it" })

    // Leaving it as it was brings the chip back
    await user.click(chip())
    await user.tab()
    expect(onOverride).not.toHaveBeenCalled()
    expect(chip()).toBeInTheDocument()

    // Escape drops what was typed
    await user.click(chip())
    await user.keyboard("Something else{Escape}")
    expect(onOverride).not.toHaveBeenCalled()
    expect(chip()).toBeInTheDocument()

    await user.click(chip())
    await user.keyboard("Something else")
    await user.tab()
    expect(onOverride).toHaveBeenCalledWith(title, "Something else")
  })

  it("asks for an output that hasn't been produced by name, and takes an empty value on Enter", async () => {
    const { user, onOverride } = setup([prTitle(undefined)])

    await user.click(screen.getByRole("button", { name: /^fetch-pr\.title: Waiting for/ }))
    const field = screen.getByLabelText("Value for fetch-pr.title")
    expect(field).toHaveValue("")
    expect(field).toHaveAttribute("placeholder", "fetch-pr.title")

    await user.keyboard("{Enter}")
    expect(onOverride).toHaveBeenCalledWith(title, "")
  })

  it("asks for a secret without showing the one it has, and keeps the new one secret", async () => {
    const { user, onOverride } = setup([prTitle(sensitiveOutput("s3cr3t"))])

    await user.click(screen.getByRole("button", { name: "fetch-pr.title: <redacted>" }))
    const field = screen.getByLabelText("Value for fetch-pr.title")
    expect(field).toHaveAttribute("type", "password")
    expect(field).toHaveValue("")

    await user.keyboard("n3w{Enter}")

    const [, value] = onOverride.mock.calls[0]!
    expect(isSensitiveOutput(value)).toBe(true)
    expect(revealOutput(value)).toBe("n3w")
    expect(document.body.innerHTML).not.toContain("s3cr3t")
  })

  it("keeps an entered value in its field, where it can be changed or reset", async () => {
    const { user, onOverride, onReset } = setup([prTitle("Fix it", "Mine")])

    const field = screen.getByLabelText("Value for fetch-pr.title")
    expect(field).toHaveAttribute("data-state", "entered")
    expect(field).toHaveValue("Mine")
    expect(field).not.toHaveFocus()

    // Enter with nothing changed leaves it as it is
    await user.click(field)
    await user.keyboard("{Enter}")
    expect(onOverride).not.toHaveBeenCalled()

    await user.click(field)
    await user.keyboard("Yours{Enter}")
    expect(onOverride).toHaveBeenCalledWith(title, "Yours")

    await user.click(screen.getByRole("button", { name: "Reset fetch-pr.title" }))
    expect(onReset).toHaveBeenCalledWith(title)
  })

  it("keeps an entered secret hidden, and unchanged until something is typed", async () => {
    const { user, onOverride } = setup([
      prTitle(sensitiveOutput("s3cr3t"), sensitiveOutput("m1ne")),
    ])

    const field = screen.getByLabelText("Value for fetch-pr.title")
    expect(field).toHaveAttribute("type", "password")
    expect(field).toHaveValue("")
    expect(field).toHaveAttribute("placeholder", "<redacted>")

    await user.click(field)
    await user.keyboard("{Enter}")
    expect(onOverride).not.toHaveBeenCalled()
    expect(document.body.innerHTML).not.toContain("m1ne")
  })

  it("shows an empty value as empty", () => {
    setup([prTitle("")])

    expect(screen.getByRole("button", { name: "fetch-pr.title: (empty)" })).toBeInTheDocument()
  })

  it("can't change an output while disabled", () => {
    setup([prTitle("Fix it", "Mine")], true)

    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.getByText("Mine")).toBeInTheDocument()
  })
})
