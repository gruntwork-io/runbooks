import { describe, it, expect, vi } from "vitest"
import { useEffect } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiProvider } from "@/contexts/ApiContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { SessionHistoryContext, type SessionHistory } from "@/contexts/SessionHistoryContext.types"
import { sensitiveOutput } from "@/lib/outputValues"
import { TestWrapper } from "@/test/test-utils"
import { OnePasswordItem } from "../OnePasswordItem"
import type { OnePasswordItemProps } from "../types"

const SAVED = { ok: true, itemId: "item1", title: "AWS prod", vaultId: "v1", vaultName: "Ops" }

function makeApi(reply: unknown = SAVED) {
  const invoke = vi.fn(async (_channel: string, _params?: unknown) => reply)
  const api = { invoke, on: vi.fn(() => () => {}) } as unknown as Parameters<
    typeof ApiProvider
  >[0]["api"]
  return { api, invoke }
}

/** Publishes an IAM user's keys, the secret one sensitive, as a Command would. */
function IamUser() {
  const { registerOutputs } = useRunbookContext()
  useEffect(
    () =>
      registerOutputs("iam", {
        ACCESS_KEY_ID: "AKIA1",
        SECRET_ACCESS_KEY: sensitiveOutput("s3cr3t"),
      }),
    [registerOutputs],
  )
  return null
}

const PROPS: OnePasswordItemProps = {
  id: "save-creds",
  vault: "Ops",
  itemTitle: "AWS prod",
  category: "API Credential",
  username: "{{ .outputs.iam.ACCESS_KEY_ID }}",
  password: "{{ .outputs.iam.SECRET_ACCESS_KEY }}",
}

function renderItem(
  props: Partial<OnePasswordItemProps> = {},
  options: { reply?: unknown; outputs?: boolean } = {},
) {
  const { api, invoke } = makeApi(options.reply)
  render(
    <ApiProvider api={api}>
      <TestWrapper>
        {options.outputs !== false && <IamUser />}
        <OnePasswordItem {...PROPS} {...props} />
      </TestWrapper>
    </ApiProvider>,
  )
  return { invoke }
}

/** A session history that keeps what blocks record, as a session does. */
function recordingHistory(): SessionHistory {
  const saved = new Map<string, unknown>()
  return {
    saved: (blockId, kind) => saved.get(`${blockId}/${kind}`),
    record: (blockId, kind, payload) => saved.set(`${blockId}/${kind}`, payload),
    finish: () => {},
  }
}

describe("OnePasswordItem", () => {
  it("shows what it will save, with secrets masked", () => {
    renderItem()
    expect(screen.getAllByText("Save to 1Password")).toHaveLength(2) // title and button
    expect(screen.getByText("AKIA1")).toBeInTheDocument()
    expect(screen.getByText("••••••••")).toBeInTheDocument()
    expect(screen.queryByText("s3cr3t")).toBeNull()
  })

  it("waits for the outputs it saves", () => {
    renderItem({}, { outputs: false })
    expect(screen.getByRole("button", { name: "Save to 1Password" })).toBeDisabled()
  })

  it("sends the raw props and the outputs, sensitive ones marked, for main to render", async () => {
    const { invoke } = renderItem()
    await userEvent.click(screen.getByRole("button", { name: "Save to 1Password" }))
    expect(invoke).toHaveBeenCalledWith("onepassword:create-item", {
      item: {
        vault: "Ops",
        title: "AWS prod",
        category: "API Credential",
        username: "{{ .outputs.iam.ACCESS_KEY_ID }}",
        password: "{{ .outputs.iam.SECRET_ACCESS_KEY }}",
        tags: [],
        fields: [],
      },
      templateInputs: {},
      templateOutputs: {
        iam: {
          ACCESS_KEY_ID: { value: "AKIA1", sensitive: false },
          SECRET_ACCESS_KEY: { value: "s3cr3t", sensitive: true },
        },
      },
    })
    expect(await screen.findByText(/Saved “AWS prod” to the Ops vault/)).toBeInTheDocument()
    expect(screen.getByText("OP_ITEM_ID")).toBeInTheDocument()
  })

  it("records an item saved after the block unmounted, so it isn't saved again", async () => {
    let reply!: (value: unknown) => void
    const invoke = vi.fn(
      (_channel: string) =>
        new Promise((resolve) => {
          reply = resolve
        }),
    )
    const api = { invoke, on: vi.fn(() => () => {}) } as unknown as Parameters<
      typeof ApiProvider
    >[0]["api"]
    const history = recordingHistory()
    const tree = (withItem: boolean) => (
      <ApiProvider api={api}>
        <SessionHistoryContext.Provider value={history}>
          <TestWrapper>
            <IamUser />
            {withItem && <OnePasswordItem {...PROPS} />}
          </TestWrapper>
        </SessionHistoryContext.Provider>
      </ApiProvider>
    )
    const { rerender } = render(tree(true))
    await userEvent.click(screen.getByRole("button", { name: "Save to 1Password" }))

    rerender(tree(false))
    await act(async () => reply(SAVED))
    rerender(tree(true))

    expect(screen.getByText(/Saved “AWS prod” to the Ops vault/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Save to 1Password" })).toBeNull()
    expect(
      invoke.mock.calls.filter(([channel]) => channel === "onepassword:create-item"),
    ).toHaveLength(1)
  })

  it("shows a failure inline and offers to try again", async () => {
    renderItem({}, { reply: { ok: false, error: "account is not signed in" } })
    await userEvent.click(screen.getByRole("button", { name: "Save to 1Password" }))
    expect(await screen.findByText("account is not signed in")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled())
  })

  it("reports a missing vault as a configuration error", () => {
    renderItem({ vault: "" })
    expect(screen.getByText(/needs a vault/)).toBeInTheDocument()
  })
})
