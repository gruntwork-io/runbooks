import { describe, it, expect } from "vitest"
import { buildLlmPrompt, LLM_PROMPT_MAX_INLINE_LINES } from "./llmPrompt"
import type { ExecutionStatus } from "../types"

const RUNBOOK = "/work/runbooks/setup/runbook.mdx"
const LOG_FILE = "/tmp/runbook-logs-abc123/exec.log"

describe("buildLlmPrompt", () => {
  it("points at the log file and asks for remediation when the step failed", () => {
    const prompt = buildLlmPrompt({
      blockId: "apply-management-org-structure",
      status: "fail",
      runbookFilePath: RUNBOOK,
      logFilePath: LOG_FILE,
      logText: "Error: something broke",
    })

    expect(prompt).toBe(
      `The logs for step \`apply-management-org-structure\` of the Gruntwork Runbook ${RUNBOOK} are in this file:\n` +
        "\n" +
        `${LOG_FILE}\n` +
        "\n" +
        "The step has failed. Analyze the failure and suggest steps for remediation to address the errors shown.",
    )
  })

  it.each<[ExecutionStatus, string]>([
    [
      "success",
      "The step succeeded. Summarize what it did and point out anything in the logs that needs attention.",
    ],
    [
      "warn",
      "The step finished with warnings. Explain the warnings and suggest steps to address them.",
    ],
    [
      "running",
      "The step is still running. Summarize its progress so far and point out any errors or warnings in the logs.",
    ],
    [
      "pending",
      "Analyze the logs and point out any errors or warnings, with steps to address them.",
    ],
  ])("uses the %s instruction", (status, instruction) => {
    const prompt = buildLlmPrompt({
      blockId: "deploy",
      status,
      runbookFilePath: RUNBOOK,
      logFilePath: LOG_FILE,
      logText: "",
    })

    expect(prompt.endsWith(`\n\n${instruction}`)).toBe(true)
    expect(prompt).not.toContain("has failed")
  })

  it("notes the remote source when the runbook was opened from a URL", () => {
    const prompt = buildLlmPrompt({
      blockId: "deploy",
      status: "fail",
      runbookFilePath: "/tmp/runbook-remote-xyz/runbook.mdx",
      remoteSource: "https://github.com/org/repo/tree/main/runbooks/setup",
      logFilePath: LOG_FILE,
      logText: "",
    })

    expect(prompt).toContain(
      "of the Gruntwork Runbook /tmp/runbook-remote-xyz/runbook.mdx (opened from https://github.com/org/repo/tree/main/runbooks/setup) are in this file:",
    )
  })

  it("names the remote source alone when no local path is known", () => {
    const prompt = buildLlmPrompt({
      blockId: "deploy",
      status: "fail",
      remoteSource: "https://github.com/org/repo",
      logFilePath: LOG_FILE,
      logText: "",
    })

    expect(prompt).toContain(
      "of the Gruntwork Runbook opened from https://github.com/org/repo are in this file:",
    )
  })

  it("falls back to a generic runbook phrase when no location is known", () => {
    const prompt = buildLlmPrompt({
      blockId: "deploy",
      status: "fail",
      logFilePath: LOG_FILE,
      logText: "",
    })

    expect(prompt).toContain("The logs for step `deploy` of a Gruntwork Runbook are in this file:")
  })

  it("does not inline the log text when a log file is available", () => {
    const prompt = buildLlmPrompt({
      blockId: "deploy",
      status: "fail",
      runbookFilePath: RUNBOOK,
      logFilePath: LOG_FILE,
      logText: "secret-looking line that should stay in the file",
    })

    expect(prompt).not.toContain("secret-looking line")
    expect(prompt).not.toContain("```")
  })

  describe("without a log file", () => {
    it("inlines the logs in a code fence", () => {
      const prompt = buildLlmPrompt({
        blockId: "clone-repo",
        status: "fail",
        runbookFilePath: RUNBOOK,
        logText: "Cloning into 'repo'...\nfatal: repository not found",
      })

      expect(prompt).toBe(
        `Here are the logs for step \`clone-repo\` of the Gruntwork Runbook ${RUNBOOK}:\n` +
          "\n" +
          "```\n" +
          "Cloning into 'repo'...\n" +
          "fatal: repository not found\n" +
          "```\n" +
          "\n" +
          "The step has failed. Analyze the failure and suggest steps for remediation to address the errors shown.",
      )
    })

    it(`keeps only the last ${LLM_PROMPT_MAX_INLINE_LINES} lines and says so`, () => {
      const total = LLM_PROMPT_MAX_INLINE_LINES + 50
      const lines = Array.from({ length: total }, (_, i) => `line ${i + 1}`)
      const prompt = buildLlmPrompt({
        blockId: "clone-repo",
        status: "fail",
        runbookFilePath: RUNBOOK,
        logText: lines.join("\n"),
      })

      expect(prompt).toContain(
        `(Only the last ${LLM_PROMPT_MAX_INLINE_LINES} of ${total} lines are shown.)`,
      )
      expect(prompt).not.toMatch(/^line 50$/m)
      expect(prompt).toContain("```\nline 51\n")
      expect(prompt).toContain(`\nline ${total}\n\`\`\`\n`)
    })

    it("adds no truncation note when every line fits", () => {
      const prompt = buildLlmPrompt({
        blockId: "clone-repo",
        status: "fail",
        logText: "one\ntwo",
      })

      expect(prompt).not.toContain("Only the last")
    })

    it("uses a longer fence when the logs contain backtick runs", () => {
      const prompt = buildLlmPrompt({
        blockId: "clone-repo",
        status: "fail",
        logText: "before\n````\ninside\n````\nafter",
      })

      expect(prompt).toContain("\n\n`````\nbefore\n````\ninside\n````\nafter\n`````\n\n")
    })
  })
})
