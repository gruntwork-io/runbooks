import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { MDX_COMPONENTS } from "@/components/MDXContainer"

/**
 * Registry-completeness guard for AI agent control (the app's MCP server).
 *
 * Every block with a button, picker or form must register an agent adapter
 * (useAgentBlock), so an agent driving a runbook never meets a block it can't
 * act on. This test enumerates the real MDX registry and fails when a block is
 * added without a decision, or when a block classified as controllable
 * doesn't call useAgentBlock.
 */

// Blocks an agent controls, through an adapter their own source registers.
const AGENT_BLOCKS = [
  "Command",
  "Check",
  "Finish",
  "Prerequisites",
  "Inputs",
  "Template",
  "TemplateInline",
  "AwsAuth",
  "GoogleAuth",
  "AzureAuth",
  "GitAuth",
  "GitHubAuth",
  "GitLabAuth",
  "GitClone",
  "GitPullRequest",
  "GitHubPullRequest",
  "GitLabMergeRequest",
  "DirPicker",
  "Iframe",
  "Admonition",
  "Chapter",
  "ShowWhen",
] as const

// Blocks whose adapter lives in a file other than `<Block>/<Block>.tsx`.
const ADAPTER_SOURCE: Record<string, string> = {
  Command: "_shared/components/ScriptBlock.tsx",
  Check: "_shared/components/ScriptBlock.tsx",
  Finish: "_shared/components/ScriptBlock.tsx",
  GitHubAuth: "GitAuth/GitAuth.tsx",
  GitLabAuth: "GitAuth/GitAuth.tsx",
  GitHubPullRequest: "GitPullRequest/GitPullRequest.tsx",
  GitLabMergeRequest: "GitPullRequest/GitPullRequest.tsx",
  Inputs: "_shared/components/BoilerplateInputsForm.tsx",
  Template: "_shared/components/BoilerplateInputsForm.tsx",
}

// Entries that aren't blocks: `a`, `pre` and `input` override plain elements.
// Every block, controls or not, reports its status through an adapter.
const NOT_AGENT_BLOCKS = ["a", "pre", "input"] as const

describe("agent adapters — MDX registry coverage", () => {
  it("every registry entry is classified (a new block forces a decision)", () => {
    const known = new Set<string>([...AGENT_BLOCKS, ...NOT_AGENT_BLOCKS])
    const unclassified = Object.keys(MDX_COMPONENTS).filter((k) => !known.has(k))
    expect(unclassified).toEqual([])
  })

  it("every classified entry is present in the registry", () => {
    const registryKeys = new Set(Object.keys(MDX_COMPONENTS))
    for (const name of [...AGENT_BLOCKS, ...NOT_AGENT_BLOCKS]) {
      expect(registryKeys.has(name)).toBe(true)
    }
  })

  it.each(AGENT_BLOCKS)("%s registers an agent adapter with a real status", (block) => {
    const relativePath = ADAPTER_SOURCE[block] ?? `${block}/${block}.tsx`
    const source = readFileSync(resolve(__dirname, "..", relativePath), "utf8")
    expect(source).toContain("useAgentBlock(")
    // The block's own status, never a placeholder for whether an agent can act on it
    expect(source).toMatch(/useAgentBlock\([\s\S]*?status: \(\) =>/)
    expect(source).not.toContain("not_controllable")
  })
})
