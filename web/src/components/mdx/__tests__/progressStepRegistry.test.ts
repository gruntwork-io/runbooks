import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { MDX_COMPONENTS } from "@/components/MDXContainer"

/**
 * Registry-completeness guard for the runbook's progress bar.
 *
 * A block the user acts on counts as a step of the runbook, done once the
 * block shows it's done. This test enumerates the real MDX registry and fails
 * if a block is added without a decision on whether it is a step, or if a
 * block classified as a step doesn't render a <ProgressStep>. In instruction
 * mode, every block counts through its "Mark as done" checkbox instead.
 */

// Blocks that count as a step of the runbook.
const STEP_BLOCKS = [
  "Command",
  "Check",
  "Finish",
  "Prerequisites",
  "AwsAuth",
  "GoogleAuth",
  "GitAuth",
  "GitHubAuth",
  "GitLabAuth",
  "Inputs",
  "Template",
  "GitClone",
  "GitPullRequest",
  "GitHubPullRequest",
  "GitLabMergeRequest",
  "DirPicker",
] as const

// Steps whose <ProgressStep> lives in a file other than `<Block>/<Block>.tsx`,
// mapped to the source path (relative to src/components/mdx/) that renders it:
//  - <Command>/<Check>/<Finish> are thin wrappers around the shared ScriptBlock.
//  - <GitHubAuth>/<GitLabAuth> alias the generic GitAuth block.
//  - <GitHubPullRequest>/<GitLabMergeRequest> alias the generic GitPullRequest block.
//  - <Inputs>/<Template> count through their shared form, when it has its own
//    Submit or Generate button.
const STEP_SOURCE: Record<string, string> = {
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

// Entries that never count:
// - TemplateInline renders files from another block's values, with nothing of
//   its own for the user to do.
// - Admonition and Iframe only display something.
// - Chapter only groups other blocks, which count as themselves.
// - `a`, `pre` and `input` override plain elements. A task-list checkbox
//   (`input`) belongs to the author's own list, not to a block.
const NOT_STEPS = [
  "TemplateInline",
  "Admonition",
  "Chapter",
  "Iframe",
  "a",
  "pre",
  "input",
] as const

describe("progress steps — MDX registry coverage", () => {
  it("every registry entry is classified (a new block forces a decision)", () => {
    const known = new Set<string>([...STEP_BLOCKS, ...NOT_STEPS])
    const unclassified = Object.keys(MDX_COMPONENTS).filter((k) => !known.has(k))
    expect(unclassified).toEqual([])
  })

  it("every classified entry is present in the registry", () => {
    const registryKeys = new Set(Object.keys(MDX_COMPONENTS))
    for (const name of [...STEP_BLOCKS, ...NOT_STEPS]) {
      expect(registryKeys.has(name)).toBe(true)
    }
  })

  it.each(STEP_BLOCKS)("%s renders a ProgressStep", (block) => {
    const relativePath = STEP_SOURCE[block] ?? `${block}/${block}.tsx`
    const source = readFileSync(resolve(__dirname, "..", relativePath), "utf8")
    expect(source).toContain("<ProgressStep")
  })
})
