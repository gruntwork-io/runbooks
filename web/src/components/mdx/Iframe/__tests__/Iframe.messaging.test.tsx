import { describe, it, expect, beforeEach, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect, type ReactNode } from "react"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { Iframe } from "../Iframe"
import type { EmbedWebview } from "../hooks/useFrameMessaging"
import {
  EMBED_PAGE_MESSAGE_CHANNEL,
  EMBED_RUNBOOK_MESSAGE_CHANNEL,
} from "../../../../../../electron/shared/embed-messaging.ts"

// The open runbook's runbook-asset:// host, as runbook:get sends it, and the
// origin its pages have.
const ASSET_HOST = "rtest"
const LOCAL_ORIGIN = `runbook-asset://${ASSET_HOST}`

/** Shows every block's registered outputs, as later blocks would see them. */
function OutputsProbe() {
  const { blockOutputs } = useRunbookContext()
  const values = Object.fromEntries(
    Object.entries(blockOutputs).map(([id, data]) => [id, data.values]),
  )
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
  return (
    <ul data-testid="reported-errors">
      {errors.map((e) => (
        <li key={e.componentId}>{e.message}</li>
      ))}
    </ul>
  )
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

/**
 * Click Load, and stand in for the webview's guest, which jsdom has none of:
 * the guest shows `url`, and `send` records what the block sends its preload.
 */
async function loadPage(url = `${LOCAL_ORIGIN}/picker.html`) {
  await userEvent.click(screen.getByRole("button", { name: "Load page" }))
  const webview = document.querySelector("webview") as EmbedWebview
  const send = vi.fn<EmbedWebview["send"]>().mockResolvedValue(undefined)
  Object.assign(webview, { getURL: () => url, send })
  return { webview, send }
}

/** Deliver `data` to the block as the guest's preload relays a message the page posted. */
function postFromPage(webview: EmbedWebview, data: unknown, channel = EMBED_PAGE_MESSAGE_CHANNEL) {
  act(() => {
    webview.dispatchEvent(Object.assign(new Event("ipc-message"), { channel, args: [data] }))
  })
}

/** The guest's page has loaded. */
function domReady(webview: EmbedWebview) {
  act(() => {
    webview.dispatchEvent(new Event("dom-ready"))
  })
}

function registeredOutputs(): unknown {
  return JSON.parse(screen.getByTestId("block-outputs").textContent!)
}

describe("Iframe messaging", () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  describe("page to runbook", () => {
    it("registers outputs the page sets under the block id, merging later messages", async () => {
      renderBlocks(
        <Iframe id="region-picker" src="./assets/picker.html" outputs={["region", "zone"]} />,
      )
      const { webview } = await loadPage()

      postFromPage(webview, { type: "runbooks:set-outputs", outputs: { region: "us-east-1" } })
      postFromPage(webview, { type: "runbooks:set-outputs", outputs: { zone: "us-east-1a" } })

      expect(registeredOutputs()).toEqual({
        region_picker: { region: "us-east-1", zone: "us-east-1a" },
      })
    })

    it("ignores the guest's other channels", async () => {
      renderBlocks(<Iframe id="picker" src="./assets/picker.html" outputs={["region"]} />)
      const { webview } = await loadPage()

      postFromPage(webview, { type: "runbooks:set-outputs", outputs: { region: "x" } }, "other")

      expect(registeredOutputs()).toEqual({})
    })

    it("ignores messages while the guest shows a page outside the runbook's assets", async () => {
      renderBlocks(<Iframe id="picker" src="./assets/picker.html" outputs={["region"]} />)
      const { webview } = await loadPage("runbook-asset://rother/picker.html")

      postFromPage(webview, { type: "runbooks:set-outputs", outputs: { region: "x" } })

      expect(registeredOutputs()).toEqual({})
    })

    it("ignores messages that aren't Runbooks messages", async () => {
      renderBlocks(<Iframe id="picker" src="./assets/picker.html" outputs={["region"]} />)
      const { webview } = await loadPage()

      postFromPage(webview, { type: "chart:resize", height: 300 })
      postFromPage(webview, "hello")

      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(registeredOutputs()).toEqual({})
    })

    it.each([
      [
        "an undeclared output",
        { region: "x", secret: "y" },
        "The page set output \"secret\", which the block's outputs prop doesn't list.",
      ],
      [
        "a non-string value",
        { region: 42 },
        'The page set output "region" to a number. Outputs must be strings.',
      ],
      [
        "an oversized value",
        { region: "x".repeat(64 * 1024 + 1) },
        'The page set output "region" to more than 65536 characters.',
      ],
      [
        "outputs that aren't an object",
        ["region"],
        "The page sent `outputs` that isn't an object of strings.",
      ],
    ])("rejects %s and shows why", async (_name, outputs, message) => {
      renderBlocks(<Iframe id="picker" src="./assets/picker.html" outputs={["region"]} />)
      const { webview } = await loadPage()

      postFromPage(webview, { type: "runbooks:set-outputs", outputs })

      expect(screen.getByRole("alert")).toHaveTextContent(message)
      expect(registeredOutputs()).toEqual({})
    })

    it("rejects an unknown Runbooks message type", async () => {
      renderBlocks(<Iframe id="picker" src="./assets/picker.html" outputs={["region"]} />)
      const { webview } = await loadPage()

      postFromPage(webview, { type: "runbooks:run-command", command: "rm -rf /" })

      expect(screen.getByRole("alert")).toHaveTextContent(
        'unknown message type, "runbooks:run-command"',
      )
    })
  })

  describe("runbook to page", () => {
    const INPUT_VALUES = { region: "us-west-2", replicas: 3 }
    const inputsMessage = (inputs: unknown) => [
      EMBED_RUNBOOK_MESSAGE_CHANNEL,
      { type: "runbooks:inputs", inputs },
    ]

    it("sends the inputsId values when the page loads and when it asks", async () => {
      renderBlocks(
        <>
          <InputsProbe id="config" values={INPUT_VALUES} />
          <Iframe src="./assets/picker.html" inputsId="config" />
        </>,
      )
      const { webview, send } = await loadPage()

      domReady(webview)
      postFromPage(webview, { type: "runbooks:get-inputs" })

      expect(send.mock.calls).toEqual([inputsMessage(INPUT_VALUES), inputsMessage(INPUT_VALUES)])
    })

    it("sends the values again when they change", async () => {
      const { rerenderBlocks } = renderBlocks(
        <>
          <InputsProbe id="config" values={INPUT_VALUES} />
          <Iframe src="./assets/picker.html" inputsId="config" />
        </>,
      )
      const { send } = await loadPage()

      const changed = { region: "eu-west-1", replicas: 3 }
      rerenderBlocks(
        <>
          <InputsProbe id="config" values={changed} />
          <Iframe src="./assets/picker.html" inputsId="config" />
        </>,
      )

      await waitFor(() => expect(send).toHaveBeenCalledWith(...inputsMessage(changed)))
    })

    it("sends nothing to a page outside the runbook's assets", async () => {
      renderBlocks(
        <>
          <InputsProbe id="config" values={INPUT_VALUES} />
          <Iframe src="./assets/picker.html" inputsId="config" />
        </>,
      )
      const { webview, send } = await loadPage("runbook-asset://rother/picker.html")

      domReady(webview)

      expect(send).not.toHaveBeenCalled()
    })

    it("shows why sending failed", async () => {
      renderBlocks(
        <>
          <InputsProbe id="config" values={INPUT_VALUES} />
          <Iframe src="./assets/picker.html" inputsId="config" />
        </>,
      )
      const { webview, send } = await loadPage()
      send.mockRejectedValue(new Error("An object could not be cloned."))

      domReady(webview)

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Couldn't send inputs to the page: An object could not be cloned.",
      )
    })

    it("sends nothing without inputsId", async () => {
      renderBlocks(<Iframe src="./assets/picker.html" />)
      const { webview, send } = await loadPage()

      domReady(webview)
      postFromPage(webview, { type: "runbooks:get-inputs" })

      expect(send).not.toHaveBeenCalled()
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
      expect(document.querySelector("webview")).toBeNull()
      await waitFor(() => expect(screen.getByTestId("reported-errors")).toHaveTextContent(message))
    })

    it("reports a duplicate id", async () => {
      renderBlocks(
        <>
          <Iframe id="picker" src="./assets/a.html" />
          <Iframe id="picker" src="./assets/b.html" />
        </>,
      )

      await waitFor(() =>
        expect(screen.getByTestId("reported-errors")).toHaveTextContent(
          'Duplicate Iframe block ID: "picker"',
        ),
      )
    })

    it("lets blocks without an id coexist", async () => {
      renderBlocks(
        <>
          <Iframe src="./assets/a.html" />
          <Iframe src="./assets/b.html" />
        </>,
      )

      await waitFor(() =>
        expect(screen.getAllByRole("button", { name: "Load page" })).toHaveLength(2),
      )
      expect(screen.queryByText("Invalid Iframe")).not.toBeInTheDocument()
    })
  })
})
