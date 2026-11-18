import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
import { RunbookContextProvider } from "@/contexts/RunbookContext"
import { DescriptionMarkdown, InlineMarkdown } from "../InlineMarkdown"

// Block titles, descriptions and messages render through InlineMarkdown, not
// the MDX compiler, so they need the same ./assets/ rewrite as the runbook body.
describe("InlineMarkdown asset paths", () => {
  it("rewrites ./assets/ image and link URLs to the runbook's runbook-asset:// host", () => {
    const { container } = render(
      <RunbookContextProvider assetHost="rtest">
        <InlineMarkdown>{"![Diagram](./assets/d.png) and [guide](./assets/g.pdf)"}</InlineMarkdown>
      </RunbookContextProvider>,
    )

    expect(container.querySelector("img")?.getAttribute("src")).toBe("runbook-asset://rtest/d.png")
    expect(container.querySelector("a")?.getAttribute("href")).toBe("runbook-asset://rtest/g.pdf")
  })

  it("keeps react-markdown URL sanitizing for every other URL", () => {
    const { container } = render(
      <InlineMarkdown>
        {"[site](https://example.com/a) ![other](./images/y.png) [bad](javascript:alert(1))"}
      </InlineMarkdown>,
    )

    const links = container.querySelectorAll("a")
    expect(links[0]!.getAttribute("href")).toBe("https://example.com/a")
    expect(container.querySelector("img")?.getAttribute("src")).toBe("./images/y.png")
    // defaultUrlTransform blanks unsafe schemes
    expect(links[1]!.getAttribute("href")).toBe("")
  })
})

// Form field descriptions (boilerplate.yml, <Inputs> YAML) render as markdown
describe("DescriptionMarkdown", () => {
  it("renders a plain one-line description as a single paragraph of its text", () => {
    const { container } = render(
      <DescriptionMarkdown>The AWS region to deploy to.</DescriptionMarkdown>,
    )

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain("text-sm")
    expect(wrapper.className).toContain("text-muted-foreground")
    expect(wrapper.innerHTML).toBe("<p>The AWS region to deploy to.</p>")
  })

  it("renders bold, italic and code", () => {
    const { container } = render(
      <DescriptionMarkdown>{"Use **single**, *not* `caf`, or ~~both~~."}</DescriptionMarkdown>,
    )

    expect(container.querySelector("strong")).toHaveTextContent("single")
    expect(container.querySelector("em")).toHaveTextContent("not")
    expect(container.querySelector("code")).toHaveTextContent("caf")
    expect(container.querySelector("del")).toHaveTextContent("both")
  })

  it("renders a block scalar's list as a list, and keeps its other line breaks", () => {
    const { container } = render(
      <DescriptionMarkdown>
        {
          "How many subscriptions:\nchoose one.\n- **single**: one.\n- **caf**: four.\n\n1. first\n2. second\n"
        }
      </DescriptionMarkdown>,
    )

    expect(container.querySelector("p")?.innerHTML).toBe("How many subscriptions:<br>\nchoose one.")
    const bullets = container.querySelectorAll("ul > li")
    expect(bullets).toHaveLength(2)
    expect(bullets[0]!.querySelector("strong")).toHaveTextContent("single")
    expect(bullets[1]).toHaveTextContent("caf: four.")
    expect(container.querySelectorAll("ol > li")).toHaveLength(2)
  })

  it("renders links that open in the browser, and blanks unsafe ones", () => {
    const { container } = render(
      <DescriptionMarkdown>
        {
          "See the [Cloud Adoption Framework](https://learn.microsoft.com/azure/) or [this](javascript:alert(1))."
        }
      </DescriptionMarkdown>,
    )

    const links = container.querySelectorAll("a")
    expect(links[0]!.getAttribute("href")).toBe("https://learn.microsoft.com/azure/")
    expect(links[0]!.getAttribute("target")).toBe("_blank")
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer")
    expect(links[1]!.getAttribute("href")).toBe("")
  })

  it("shows raw HTML as text instead of rendering it", () => {
    const { container } = render(
      <DescriptionMarkdown>
        {'Directory modules/<name>. <b>bold</b><script>alert(1)</script>\n<img src="x.png">'}
      </DescriptionMarkdown>,
    )

    expect(container.querySelector("b, script, img")).toBeNull()
    expect(container).toHaveTextContent(
      "Directory modules/<name>. <b>bold</b><script>alert(1)</script>",
    )
  })

  it("drops images", () => {
    const { container } = render(
      <DescriptionMarkdown>{"Before ![diagram](./assets/d.png) after"}</DescriptionMarkdown>,
    )

    expect(container.querySelector("img")).toBeNull()
    expect(container).toHaveTextContent("Before after")
  })

  it("keeps text that would be a heading, quote, rule or code block as written", () => {
    const { container } = render(
      <DescriptionMarkdown>
        {"# of replicas\n> 3 is safest\n    indented\n---"}
      </DescriptionMarkdown>,
    )

    expect(container.querySelector("h1, h2, blockquote, pre, hr")).toBeNull()
    expect(container.querySelector("p")?.innerHTML).toBe(
      "# of replicas<br>\n&gt; 3 is safest<br>\nindented<br>\n---",
    )
  })
})
