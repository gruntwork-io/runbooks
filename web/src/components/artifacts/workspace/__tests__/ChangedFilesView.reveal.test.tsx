import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import type { WorkspaceFileChange } from "@/hooks/useGitFileChanges"
import { ChangedFilesView } from "../ChangedFilesView"

const change = (path: string): WorkspaceFileChange => ({
  path,
  changeType: "added",
  additions: 1,
  deletions: 0,
  language: "hcl",
  originalContent: "",
  newContent: "x\n",
})

const README = change("README.md")
const UNIT = change("buckets/logs/terragrunt.hcl")

const row = (name: string) => screen.queryByRole("treeitem", { name })
/** Whether a file's tree row, or the row element around it, has a class. */
const rowHas = (name: string, className: string) => !!row(name)?.closest(`.${className}`)
const card = (path: string) => screen.getByTestId(`diff-file-${path}`)
/** Lets the view's next animation frames run. */
const nextFrames = () => act(() => vi.advanceTimersByTime(50))

describe("ChangedFilesView reveal", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("waits for a revealed file to change, then selects it, opens its folders and flashes it", async () => {
    const reveal = { id: 1, paths: [UNIT.path] }
    const { rerender } = render(<ChangedFilesView changes={[README]} reveal={reveal} />)
    await nextFrames()
    expect(rowHas("README.md", "animate-reveal-flash")).toBe(false)

    // The block's file shows up in the next refresh, in a folder that wasn't there.
    rerender(<ChangedFilesView changes={[README, UNIT]} reveal={reveal} />)
    await nextFrames()

    expect(rowHas("terragrunt.hcl", "animate-reveal-flash")).toBe(true)
    expect(rowHas("terragrunt.hcl", "bg-info-muted")).toBe(true)
    expect(card(UNIT.path)).toHaveClass("animate-reveal-glow", "ring-2")
    expect(card(README.path)).not.toHaveClass("animate-reveal-glow")

    await act(() => vi.advanceTimersByTime(2400))
    expect(rowHas("terragrunt.hcl", "animate-reveal-flash")).toBe(false)
    expect(rowHas("terragrunt.hcl", "bg-info-muted")).toBe(true)
  })

  it("shows each request once, and the same files again for a new one", async () => {
    const { rerender } = render(
      <ChangedFilesView changes={[README, UNIT]} reveal={{ id: 1, paths: [UNIT.path] }} />,
    )
    await nextFrames()
    await act(() => vi.advanceTimersByTime(2400))

    // A refresh with the same request doesn't flash again.
    rerender(
      <ChangedFilesView
        changes={[README, { ...UNIT, additions: 2 }]}
        reveal={{ id: 1, paths: [UNIT.path] }}
      />,
    )
    await nextFrames()
    expect(card(UNIT.path)).not.toHaveClass("animate-reveal-glow")

    rerender(<ChangedFilesView changes={[README, UNIT]} reveal={{ id: 2, paths: [UNIT.path] }} />)
    await nextFrames()
    expect(card(UNIT.path)).toHaveClass("animate-reveal-glow")
  })
})
