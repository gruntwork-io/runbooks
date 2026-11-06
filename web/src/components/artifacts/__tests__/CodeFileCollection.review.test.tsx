import { useEffect } from "react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { GeneratedFilesProvider } from "@/contexts/GeneratedFilesContext"
import type { FileTreeResponse } from "@/contexts/GeneratedFilesContext.types"
import { useGeneratedFiles } from "@/hooks/useGeneratedFiles"
import { useGeneratedFilesReview } from "@/hooks/useGeneratedFilesReview"
import type { FileTreeNode } from "@/components/artifacts/code/FileTree"
import { CodeFileCollection } from "@/components/artifacts/code/CodeFileCollection"

// The real provider keeps what was reviewed; the files arrive the way a
// block's render delivers them, through updateGeneratedFileTree.
let deliver: (response: FileTreeResponse) => void = () => {}

function GeneratedFiles() {
  const { fileTree, updateGeneratedFileTree } = useGeneratedFiles()
  const review = useGeneratedFilesReview()
  useEffect(() => {
    deliver = updateGeneratedFileTree
  }, [updateGeneratedFileTree])
  return <CodeFileCollection data={fileTree ?? []} review={review} />
}

const file = (path: string, content: string): FileTreeNode => {
  const name = path.split("/").pop()!
  return {
    id: path,
    name,
    type: "file",
    children: [],
    file: { name, path, content, language: "hcl", size: content.length },
  }
}

const tree = (main: string): FileTreeResponse => ({
  fileTree: [
    { id: "infra", name: "infra", type: "folder", children: [file("infra/main.tf", main)] },
    file("README.md", "readme\n"),
  ],
})

const MAIN_V1 = "a\nb\nc\nd\n"
const MAIN_V2 = "a\nb\nC\nd\n"

const card = (path: string) => screen.getByTestId(`code-file-${path}`)
const treeItem = (name: string) => screen.getByRole("treeitem", { name })

async function generate(main: string) {
  await act(async () => deliver(tree(main)))
}

/**
 * Lays out the pane that shows the files, which jsdom doesn't: the elements
 * `bottoms` selects end where it says, in the pane's scroll coordinates.
 * Returns a function that scrolls the pane.
 */
function layOutFilesPane(bottoms: [selector: string, bottom: number][]) {
  const pane = card("README.md").closest<HTMLElement>(".overflow-y-auto")!
  Object.defineProperty(pane, "scrollTop", { value: 0, writable: true, configurable: true })
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const bottom = bottoms.find(([selector]) => this.matches(selector))?.[1] ?? 0
    return { top: 0, bottom: bottom - pane.scrollTop } as DOMRect
  })
  return {
    pane,
    scrollTo: (top: number) => {
      pane.scrollTop = top
      fireEvent.scroll(pane)
    },
  }
}

/** Render, generate the files, and review them all. */
async function setUp() {
  const user = userEvent.setup()
  render(
    <GeneratedFilesProvider>
      <GeneratedFiles />
    </GeneratedFilesProvider>,
  )
  await generate(MAIN_V1)
  for (const button of screen.getAllByRole("button", { name: "Dismiss" })) {
    await user.click(button)
  }
  return user
}

describe("CodeFileCollection highlighting the files changed since they were reviewed", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0)
      return 0
    })
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => vi.restoreAllMocks())

  it("marks files never reviewed as added, in the tree and on the file", async () => {
    render(
      <GeneratedFilesProvider>
        <GeneratedFiles />
      </GeneratedFilesProvider>,
    )
    await generate(MAIN_V1)

    expect(card("README.md")).toHaveAttribute("data-change", "added")
    expect(within(card("README.md")).getByText("Added")).toBeInTheDocument()
    expect(treeItem("README.md")).toHaveAttribute(
      "aria-description",
      "Added since you last reviewed it",
    )
    // main.tf is inside the collapsed folder, which says it holds a change.
    expect(treeItem("infra")).toHaveAttribute(
      "aria-description",
      "Holds files changed since you last reviewed them",
    )
  })

  it("highlights the lines a new render changed in a reviewed file", async () => {
    const user = await setUp()
    expect(card("infra/main.tf")).not.toHaveAttribute("data-change")
    expect(treeItem("infra")).not.toHaveAttribute("aria-description")

    await generate(MAIN_V2)

    const main = card("infra/main.tf")
    expect(main).toHaveAttribute("data-change", "modified")
    expect(within(main).getByText("Modified")).toHaveTextContent("Modified +1 -1")
    expect(main.querySelector('[data-line="3"]')).toHaveStyle({
      backgroundColor: "color-mix(in oklch, var(--success) 20%, transparent)",
    })
    expect((main.querySelector('[data-line="2"]') as HTMLElement).style.backgroundColor).toBe("")
    expect(card("README.md")).not.toHaveAttribute("data-change")

    await user.click(treeItem("infra"))
    expect(treeItem("main.tf")).toHaveAttribute(
      "aria-description",
      "Modified since you last reviewed it",
    )
  })

  it("opens a changed file at its first change, and stops highlighting it once another file is selected", async () => {
    const user = await setUp()
    await generate(MAIN_V2)
    await user.click(treeItem("infra"))

    await user.click(treeItem("main.tf"))
    const scrolled = vi.mocked(Element.prototype.scrollIntoView)
    expect(scrolled.mock.contexts.at(-1)).toBe(
      card("infra/main.tf").querySelector('[data-line="3"]'),
    )
    expect(scrolled).toHaveBeenLastCalledWith({ behavior: "auto", block: "center" })
    // Still highlighted while it is the file under review
    expect(card("infra/main.tf")).toHaveAttribute("data-change", "modified")

    await user.click(treeItem("README.md"))
    expect(card("infra/main.tf")).not.toHaveAttribute("data-change")
    expect(card("infra/main.tf").querySelector("[data-line]")).toBeNull()
    expect(treeItem("main.tf")).not.toHaveAttribute("aria-description")
    // An unchanged file opens at its top.
    expect(scrolled.mock.contexts.at(-1)).toBe(card("README.md"))
  })

  it("updates the highlights of the selected file as it changes, and reviews them when another is selected", async () => {
    const user = await setUp()
    await generate(MAIN_V2)
    await user.click(treeItem("infra"))
    await user.click(treeItem("main.tf"))

    // A render while the file is selected, such as a template following the form
    await generate("A\nb\nC\nd\n")
    const main = card("infra/main.tf")
    expect(within(main).getByText("Modified")).toHaveTextContent("Modified +2 -2")
    expect(main.querySelector('[data-line="1"]')).toHaveStyle({
      backgroundColor: "color-mix(in oklch, var(--success) 20%, transparent)",
    })

    await user.click(treeItem("README.md"))
    expect(card("infra/main.tf")).not.toHaveAttribute("data-change")
  })

  it("reviews a changed file once the user scrolls down past its changes", async () => {
    await setUp()
    await generate(MAIN_V2)
    const { pane, scrollTo } = layOutFilesPane([
      ['[data-testid="code-file-infra/main.tf"] [data-line="3"]', 300],
    ])

    fireEvent.wheel(pane)
    scrollTo(250)
    expect(card("infra/main.tf")).toHaveAttribute("data-change", "modified")

    fireEvent.wheel(pane)
    scrollTo(320)
    expect(card("infra/main.tf")).not.toHaveAttribute("data-change")
  })

  it("leaves a changed file highlighted when a jump to another file goes past it", async () => {
    const user = await setUp()
    await generate(MAIN_V2)
    const { pane, scrollTo } = layOutFilesPane([
      ['[data-testid="code-file-infra/main.tf"] [data-line="3"]', 300],
    ])

    fireEvent.wheel(pane)
    await user.click(treeItem("README.md"))
    scrollTo(800)
    expect(card("infra/main.tf")).toHaveAttribute("data-change", "modified")
  })

  it("stops highlighting a dismissed file without collapsing it", async () => {
    const user = await setUp()
    await generate(MAIN_V2)

    await user.click(within(card("infra/main.tf")).getByRole("button", { name: "Dismiss" }))

    expect(card("infra/main.tf")).not.toHaveAttribute("data-change")
    // The code is still shown: the click did not reach the header.
    expect(card("infra/main.tf").querySelector("code")).toHaveTextContent("C")
  })
})
