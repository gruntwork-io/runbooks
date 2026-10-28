import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { MDX_COMPONENTS } from "@/components/MDXContainer"

/**
 * Registry-completeness guard for the `autoCollapse` prop.
 *
 * A step of the runbook (see progressStepRegistry.test.ts) can fold into a bar
 * once it's done. This test enumerates the real MDX registry and fails if a
 * block is added without a decision on whether it folds, or if a block that
 * folds doesn't render an <AutoCollapse> with a collapse button.
 */

// Blocks that take `autoCollapse`
const COLLAPSIBLE_BLOCKS = [
  "Command",
  "Check",
  "Prerequisites",
  "AwsAuth",
  "GoogleAuth",
  "GitAuth",
  "GitHubAuth",
  "GitLabAuth",
  "GitClone",
  "GitPullRequest",
  "GitHubPullRequest",
  "GitLabMergeRequest",
] as const

// Collapsible blocks whose interactive UI lives in a file other than
// `<Block>/<Block>.tsx`, mapped to that file (relative to src/components/mdx/)
const BLOCK_SOURCE: Record<string, string> = {
  Command: "_shared/components/ScriptBlock.tsx",
  Check: "_shared/components/ScriptBlock.tsx",
  GitHubAuth: "GitAuth/GitAuth.tsx",
  GitLabAuth: "GitAuth/GitAuth.tsx",
  GitHubPullRequest: "GitPullRequest/GitPullRequest.tsx",
  GitLabMergeRequest: "GitPullRequest/GitPullRequest.tsx",
}

// The file that renders each collapsible block's shared <Instruction>, which
// folds it in instruction mode once it's marked done
const INSTRUCTION_SOURCE: Record<(typeof COLLAPSIBLE_BLOCKS)[number], string> = {
  Command: "_shared/components/ScriptBlock.tsx",
  Check: "_shared/components/ScriptBlock.tsx",
  Prerequisites: "Prerequisites/Prerequisites.tsx",
  AwsAuth: "AwsAuth/AwsAuthInstruction.tsx",
  GoogleAuth: "GoogleAuth/GoogleAuthInstruction.tsx",
  GitAuth: "GitAuth/GitAuthInstruction.tsx",
  GitHubAuth: "GitAuth/GitAuthInstruction.tsx",
  GitLabAuth: "GitAuth/GitAuthInstruction.tsx",
  GitClone: "GitClone/GitCloneInstruction.tsx",
  GitPullRequest: "GitPullRequest/GitPullRequestInstruction.tsx",
  GitHubPullRequest: "GitPullRequest/GitPullRequestInstruction.tsx",
  GitLabMergeRequest: "GitPullRequest/GitPullRequestInstruction.tsx",
}

// Entries that never fold:
// - Finish shows the author's next steps once the runbook is finished.
// - Inputs and Template have no title to show on the bar, and their values are
//   worth reviewing.
// - DirPicker is done from its first pick, before the user has picked every
//   level.
// - The rest aren't steps: nothing in them becomes done.
const NOT_COLLAPSIBLE = [
  "Finish",
  "Inputs",
  "Template",
  "DirPicker",
  "TemplateInline",
  "Admonition",
  "Chapter",
  "Iframe",
  "a",
  "pre",
  "input",
] as const

const sourceOf = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8")

describe("autoCollapse — MDX registry coverage", () => {
  it("every registry entry is classified (a new block forces a decision)", () => {
    const known = new Set<string>([...COLLAPSIBLE_BLOCKS, ...NOT_COLLAPSIBLE])
    const unclassified = Object.keys(MDX_COMPONENTS).filter((k) => !known.has(k))
    expect(unclassified).toEqual([])
  })

  it("every classified entry is present in the registry", () => {
    const registryKeys = new Set(Object.keys(MDX_COMPONENTS))
    for (const name of [...COLLAPSIBLE_BLOCKS, ...NOT_COLLAPSIBLE]) {
      expect(registryKeys.has(name)).toBe(true)
    }
  })

  it.each(COLLAPSIBLE_BLOCKS)("%s folds once done, with a collapse button", (block) => {
    const source = sourceOf(BLOCK_SOURCE[block] ?? `${block}/${block}.tsx`)
    expect(source).toContain("<AutoCollapse")
    expect(source).toContain("<CollapseButton />")
  })

  it.each(COLLAPSIBLE_BLOCKS)("%s passes autoCollapse to its instruction", (block) => {
    expect(sourceOf(INSTRUCTION_SOURCE[block])).toContain("autoCollapse={autoCollapse}")
  })

  it("the shared instruction folds once marked done, with a collapse button", () => {
    const source = sourceOf("_shared/components/Instruction.tsx")
    expect(source).toContain("<AutoCollapse")
    expect(source).toContain("<CollapseButton />")
  })
})
