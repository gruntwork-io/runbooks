import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { ViewLogs } from "../ViewLogs"
import { RunbookContextProvider } from "@/contexts/RunbookContext"
import type { LogEntry } from "@/hooks/useApiExec"

const RUNBOOK = "/work/runbooks/setup/runbook.mdx"
const LOG_FILE = "/tmp/runbook-logs-abc123/exec.log"
const FAIL_INSTRUCTION =
  "The step has failed. Analyze the failure and suggest steps for remediation to address the errors shown."
const SUCCESS_INSTRUCTION =
  "The step succeeded. Summarize what it did and point out anything in the logs that needs attention."

function entry(line: string): LogEntry {
  return { line, timestamp: "2026-01-01T00:00:00.000Z" }
}

function renderViewLogs(
  props: Partial<ComponentProps<typeof ViewLogs>> = {},
  remoteSource?: string,
) {
  return render(
    <RunbookContextProvider
      runbookName="setup"
      runbookFilePath={RUNBOOK}
      remoteSource={remoteSource}
    >
      <ViewLogs logs={[]} status="pending" blockId="deploy-infra" {...props} />
    </RunbookContextProvider>,
  )
}

const PROMPT_BUTTON = { name: "Copy prompt for LLM" }
const promptButton = () => screen.getByRole("button", PROMPT_BUTTON)

describe("ViewLogs — Copy prompt for LLM", () => {
  it("copies a prompt naming the step, runbook and log file when the step failed", async () => {
    const user = userEvent.setup()
    renderViewLogs({
      status: "fail",
      logs: [entry("Error: access denied")],
      logFilePath: LOG_FILE,
    })

    await user.click(promptButton())

    const copied = await navigator.clipboard.readText()
    expect(copied).toBe(
      `The logs for step \`deploy-infra\` of the Gruntwork Runbook ${RUNBOOK} are in this file:\n\n${LOG_FILE}\n\n${FAIL_INSTRUCTION}`,
    )
    // Same "copied" feedback as the neighbouring copy buttons: the icon becomes a check mark.
    expect(promptButton().querySelector(".lucide-check")).not.toBeNull()
  })

  it("is available as soon as a log file exists, before any output", () => {
    renderViewLogs({ status: "running", logFilePath: LOG_FILE })
    expect(promptButton()).toBeInTheDocument()
  })

  it("is hidden when there are neither logs nor a log file", () => {
    // A GitClone or GitPullRequest run starts like this: the toolbar is up
    // (Maximize is offered) but there is nothing yet to build a prompt from.
    renderViewLogs({ status: "running" })
    expect(screen.getByRole("button", { name: "Maximize logs" })).toBeInTheDocument()
    expect(screen.queryByRole("button", PROMPT_BUTTON)).not.toBeInTheDocument()
  })

  it("inlines the plain-text logs when there is no log file", async () => {
    const user = userEvent.setup()
    renderViewLogs({
      status: "fail",
      logs: [
        entry("Cloning into 'repo'..."),
        entry("\u001b[31mfatal: repository not found\u001b[0m"),
      ],
    })

    await user.click(promptButton())

    const copied = await navigator.clipboard.readText()
    expect(copied).toContain(
      `Here are the logs for step \`deploy-infra\` of the Gruntwork Runbook ${RUNBOOK}:`,
    )
    expect(copied).toContain("```\nCloning into 'repo'...\nfatal: repository not found\n```")
    expect(copied).not.toContain("\u001b[")
    expect(copied.endsWith(FAIL_INSTRUCTION)).toBe(true)
  })

  it("renders without a RunbookContextProvider and falls back to a generic runbook phrase", async () => {
    const user = userEvent.setup()
    render(
      <ViewLogs
        logs={[entry("done")]}
        status="success"
        blockId="deploy-infra"
        logFilePath={LOG_FILE}
      />,
    )

    await user.click(promptButton())

    const copied = await navigator.clipboard.readText()
    expect(copied).toContain(
      "The logs for step `deploy-infra` of a Gruntwork Runbook are in this file:",
    )
    expect(copied.endsWith(SUCCESS_INSTRUCTION)).toBe(true)
  })

  it("names the URL a remote runbook was opened from", async () => {
    const user = userEvent.setup()
    const url = "https://github.com/org/repo/tree/main/runbooks/setup"
    renderViewLogs(
      { status: "fail", logs: [entry("Error: access denied")], logFilePath: LOG_FILE },
      url,
    )

    await user.click(promptButton())

    const copied = await navigator.clipboard.readText()
    expect(copied).toContain(
      `of the Gruntwork Runbook ${RUNBOOK} (opened from ${url}) are in this file:`,
    )
  })
})
