import { describe, it, expect, beforeEach, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect, type ReactNode } from "react"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { Iframe } from "../Iframe"

// The open runbook's runbook-asset:// host, as runbook:get sends it, and the
// origin its pages have.
const ASSET_HOST = "rtest"
const LOCAL_ORIGIN = `runbook-asset://${ASSET_HOST}`

/** Shows every block's registered outputs, as later blocks would see them. */
function OutputsProbe() {
  const { blockOutputs } = useRunbookContext()
  const values = Object.fromEntries(Object.entries(blockOutputs).map(([id, data]) => [id, data.values]))
  return <pre data-testid="block-outputs">{JSON.stringify(values)}</pre>
}

/** Registers an Inputs block's values, as an <Inputs> block would. */
function InputsProbe({ id, values }: { id: string; values: Record<string, unknown> }) {
  const { registerInputs } = useRunbookContext()
  useEffect(() => {
    registerInputs(id, values, { variables: [] })
  }, [id, values, registerInputs])
  return null
}

function ReportedErrors() {
  const { errors } = useErrorReporting()
  return <ul data-testid="reported-errors">{errors.map((e) => <li key={e.componentId}>{e.message}</li>)}</ul>
}

function blocks(children: ReactNode) {
  return (
    <TestWrapper assetHost={ASSET_HOST}>
      {children}
      <OutputsProbe />
      <ReportedErrors />
    </TestWrapper>
  )
}

function renderBlocks(children: ReactNode) {
  const result = render(blocks(children))
  return { ...result, rerenderBlocks: (next: ReactNode) => result.rerender(blocks(next)) }
}

async function loadPage() {
  await userEvent.click(screen.getByRole("button", { name: "Load page" }))
  return document.querySelector("iframe")!
}

/** Deliver `data` to the runbook as if posted from `source` at `origin`. */
function postFromPage(data: unknown, source: Window | null, origin = LOCAL_ORIGIN) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source }))
  })
}

function blockOutputs(): unknown {
  return JSON.parse(screen.getByTestId("block-outputs").textContent!)
}

describe("Iframe messaging", () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  describe("page to runbook", () => {
    it("registers outputs the page sets under the block id, merging later messages", async () => {
      renderBlocks(<Iframe id="region-picker" src="./assets/picker.html" outputs={["region", "zone"]} />)
      const frame = await loadPage()

      postFromPage({ type: "runbooks:set-outputs", outputs: { region: "us-east-1" } }, frame.contentWindow)
      postFromPage({ type: "runbooks:set-outputs", outputs: { zone: "us-east-1a" } }, frame.contentWindow)

      expect(blockOutputs()).toEqual({ region_picker: { region: "us-east-1", zone: "us-east-1a" } })
    })

    it("ignores messages from another window", async () => {
      renderBlocks(<Iframe id="picker" src="./assets/picker.html" outputs={["region"]} />)
      await loadPage()

      postFromPage({ type: "runbooks:set-outputs", outputs: { region: "x" } }, window)

      expect(blockOutputs()).toEqual({})
    })

    it("ignores messages once the frame has navigated to another origin", async () => {
      renderBlocks(<Iframe id="picker" src="./assets/picker.html" outputs={["region"]} />)
      const frame = await loadPage()

      postFromPage({ type: "runbooks:set-outputs", outputs: { region: "x" } }, frame.contentWindow, "https://evil.example")

      expect(blockOutputs()).toEqual({})
    })

    it("ignores messages that aren't Runbooks messages", async () => {
      renderBlocks(<Iframe id="picker" src="./assets/picker.html" outputs={["region"]} />)
      const frame = await loadPage()

      postFromPage({ type: "chart:resize", height: 300 }, frame.contentWindow)
      postFromPage("hello", frame.contentWindow)

      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(blockOutputs()).toEqual({})
    })

    it.each([
      ["an undeclared output", { region: "x", secret: "y" }, 'The page set output "secret", which the block\'s outputs prop doesn\'t list.'],
      ["a non-string value", { region: 42 }, 'The page set output "region" to a number. Outputs must be strings.'],
      ["an oversized value", { region: "x".repeat(64 * 1024 + 1) }, 'The page set output "region" to more than 65536 characters.'],
      ["outputs that aren't an object", ["region"], "The page sent `outputs` that isn't an object of strings."],
    ])("rejects %s and shows why", async (_name, outputs, message) => {
      renderBlocks(<Iframe id="picker" src="./assets/picker.html" outputs={["region"]} />)
      const frame = await loadPage()

      postFromPage({ type: "runbooks:set-outputs", outputs }, frame.contentWindow)

      expect(screen.getByRole("alert")).toHaveTextContent(message)
      expect(blockOutputs()).toEqual({})
    })

    it("rejects an unknown Runbooks message type", async () => {
      renderBlocks(<Iframe id="picker" src="./assets/picker.html" outputs={["region"]} />)
      const frame = await loadPage()

      postFromPage({ type: "runbooks:run-command", command: "rm -rf /" }, frame.contentWindow)

      expect(screen.getByRole("alert")).toHaveTextContent('unknown message type, "runbooks:run-command"')
    })
  })

  describe("runbook to page", () => {
    const INPUT_VALUES = { region: "us-west-2", replicas: 3 }

    it("sends the inputsId values when the page loads and when it asks", async () => {
      renderBlocks(
        <>
          <InputsProbe id="config" values={INPUT_VALUES} />
          <Iframe src="./assets/picker.html" inputsId="config" />
        </>,
      )
      const frame = await loadPage()
      const postMessage = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {})

      fireEvent.load(frame)
      postFromPage({ type: "runbooks:get-inputs" }, frame.contentWindow)

      expect(postMessage).toHaveBeenCalledTimes(2)
      for (const call of postMessage.mock.calls) {
        expect(call).toEqual([{ type: "runbooks:inputs", inputs: INPUT_VALUES }, LOCAL_ORIGIN])
      }
    })

    it("sends the values again when they change", async () => {
      const { rerenderBlocks } = renderBlocks(
        <>
          <InputsProbe id="config" values={INPUT_VALUES} />
          <Iframe src="./assets/picker.html" inputsId="config" />
        </>,
      )
      const frame = await loadPage()
      const postMessage = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {})

      const changed = { region: "eu-west-1", replicas: 3 }
      rerenderBlocks(
        <>
          <InputsProbe id="config" values={changed} />
          <Iframe src="./assets/picker.html" inputsId="config" />
        </>,
      )

      await waitFor(() =>
        expect(postMessage).toHaveBeenCalledWith({ type: "runbooks:inputs", inputs: changed }, LOCAL_ORIGIN),
      )
    })

    it("sends nothing without inputsId", async () => {
      renderBlocks(<Iframe src="./assets/picker.html" />)
      const frame = await loadPage()
      const postMessage = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {})

      fireEvent.load(frame)
      postFromPage({ type: "runbooks:get-inputs" }, frame.contentWindow)

      expect(postMessage).not.toHaveBeenCalled()
    })
  })

  describe("configuration", () => {
    it.each<[string, React.ComponentProps<typeof Iframe>, string]>([
      [
        "messaging props on an external site",
        { src: "https://example.com", inputsId: "config" },
        "The inputsId and outputs props only work with a page from ./assets/.",
      ],
      [
        "outputs without an id",
        { src: "./assets/picker.html", outputs: ["region"] },
        "An Iframe with outputs needs an id.",
      ],
      [
        "an invalid output name",
        { id: "picker", src: "./assets/picker.html", outputs: ["aws-region"] },
        'Output name "aws-region" is invalid.',
      ],
    ])("reports %s", async (_name, props, message) => {
      renderBlocks(<Iframe {...props} />)

      expect(screen.getByText("Invalid Iframe")).toBeInTheDocument()
      expect(document.querySelector("iframe")).toBeNull()
      await waitFor(() => expect(screen.getByTestId("reported-errors")).toHaveTextContent(message))
    })

    it("reports a duplicate id", async () => {
      renderBlocks(
        <>
          <Iframe id="picker" src="./assets/a.html" />
          <Iframe id="picker" src="./assets/b.html" />
        </>,
      )

      await waitFor(() => expect(screen.getByTestId("reported-errors")).toHaveTextContent('Duplicate Iframe block ID: "picker"'))
    })

    it("lets blocks without an id coexist", async () => {
      renderBlocks(
        <>
          <Iframe src="./assets/a.html" />
          <Iframe src="./assets/b.html" />
        </>,
      )

      await waitFor(() => expect(screen.getAllByRole("button", { name: "Load page" })).toHaveLength(2))
      expect(screen.queryByText("Invalid Iframe")).not.toBeInTheDocument()
    })
  })
})
